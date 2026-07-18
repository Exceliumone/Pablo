//! The orchestrator / control-plane HTTP server — the only binary
//! apps/api talks to. Owns the lifecycle of per-user `executor` child
//! processes (spawn on start, SIGTERM on stop, detect unexpected exits)
//! and exposes that as a small internal REST API. Never runs any trading
//! logic itself.

use std::net::SocketAddr;
use std::process::Stdio;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use dashmap::DashMap;
use engine_bridge::contract::{BotEvent, BotStatus, ExecutorStartPayload, ExecutorStatusView};
use engine_bridge::events::{now_iso, publish_event};
use futures_util::StreamExt;
use serde::Serialize;

#[derive(Clone)]
struct ExecutorState {
    status: BotStatus,
    pid: Option<u32>,
    started_at: Option<String>,
    last_event_at: Option<String>,
    last_error: Option<String>,
    /// Total number of times this user's executor has been spawned —
    /// explicit starts and auto-restarts both count, since both are real
    /// process restarts the user should be able to see (`restart_count` on
    /// `ExecutorStatusView`).
    restart_count: u32,
    /// Consecutive *unexpected-exit* restarts since the last time this
    /// executor reported `Running`, or since the user last explicitly
    /// clicked Start. Resets to 0 on either signal; caps auto-restart via
    /// `MAX_CONSECUTIVE_CRASHES` so a persistently broken config (bad RPC
    /// URL, empty wallet) doesn't spin the process forever.
    consecutive_crash_count: u32,
    /// The payload needed to respawn this user's executor after an
    /// unexpected crash, without another `/start` call from apps/api.
    /// Cleared on an explicit stop — see `stop_executor` — so a decrypted
    /// wallet secret doesn't linger in this registry longer than there's
    /// an actual use for it.
    last_payload: Option<ExecutorStartPayload>,
}

impl Default for ExecutorState {
    fn default() -> Self {
        Self {
            status: BotStatus::Stopped,
            pid: None,
            started_at: None,
            last_event_at: None,
            last_error: None,
            restart_count: 0,
            consecutive_crash_count: 0,
            last_payload: None,
        }
    }
}

struct AppCtx {
    registry: DashMap<String, ExecutorState>,
    internal_token: String,
    executor_bin_path: std::path::PathBuf,
    redis_client: redis::Client,
}

fn to_view(user_id: &str, state: &ExecutorState) -> ExecutorStatusView {
    ExecutorStatusView {
        user_id: user_id.to_string(),
        status: state.status,
        pid: state.pid,
        started_at: state.started_at.clone(),
        last_event_at: state.last_event_at.clone(),
        last_error: state.last_error.clone(),
        restart_count: state.restart_count,
    }
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
    service: &'static str,
}

#[derive(Serialize)]
struct Version {
    engine_bridge: &'static str,
    trading_engine_crate: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        service: "engine-bridge",
    })
}

async fn version() -> Json<Version> {
    Json(Version {
        engine_bridge: env!("CARGO_PKG_VERSION"),
        trading_engine_crate: "solana-vntr-sniper",
    })
}

fn check_auth(ctx: &AppCtx, headers: &HeaderMap) -> Result<(), StatusCode> {
    let provided = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    match provided {
        Some(token) if token == ctx.internal_token => Ok(()),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

/// An unexpected exit is retried at most this many times in a row (reset
/// whenever the executor reaches `Running`, or the user explicitly starts
/// it again) before giving up and leaving it in `Error` — a persistently
/// broken config (bad RPC URL, empty wallet) should surface as a visible
/// error, not spin the process forever.
const MAX_CONSECUTIVE_CRASHES: u32 = 5;

fn restart_backoff(consecutive_crash_count: u32) -> std::time::Duration {
    let secs = 2u64.saturating_pow(consecutive_crash_count.min(6));
    std::time::Duration::from_secs(secs.min(60))
}

/// Spawns the executor child process for `user_id`, wires up its
/// stdout/stderr relay, and owns it in an exit-monitor task. Shared by the
/// HTTP start handler and the crash-recovery path in that monitor task —
/// the only difference between "a user clicked Start" and "the previous
/// attempt just crashed and this is a retry" is `consecutive_crash_count`.
fn spawn_executor(
    ctx: Arc<AppCtx>,
    user_id: String,
    payload: ExecutorStartPayload,
    consecutive_crash_count: u32,
) -> Result<(), StatusCode> {
    let payload_json = serde_json::to_string(&payload).map_err(|_| StatusCode::BAD_REQUEST)?;

    let mut child = tokio::process::Command::new(&ctx.executor_bin_path)
        .env("EXECUTOR_CONFIG_JSON", payload_json)
        .env("RUST_LOG", "info")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            tracing::error!(error = %e, %user_id, "failed to spawn executor");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    let pid = child.id();
    let restart_count = ctx
        .registry
        .get(&user_id)
        .map(|s| s.restart_count + 1)
        .unwrap_or(0);

    ctx.registry.insert(
        user_id.clone(),
        ExecutorState {
            status: BotStatus::Starting,
            pid,
            started_at: Some(now_iso()),
            last_event_at: None,
            last_error: None,
            restart_count,
            consecutive_crash_count,
            last_payload: Some(payload),
        },
    );

    // Relay the child's stdout/stderr into our own structured logs (its
    // own colored `Logger` output — human-readable, not parsed).
    if let Some(stdout) = child.stdout.take() {
        let user_id = user_id.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::info!(%user_id, executor_log = %line);
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let user_id = user_id.clone();
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::warn!(%user_id, executor_log = %line);
            }
        });
    }

    // Own the child exclusively in a monitor task so a crash/exit updates
    // the registry without needing shared-mutable access to `Child`.
    let ctx_bg = ctx.clone();
    let user_id_bg = user_id.clone();
    tokio::spawn(async move {
        let exit = child.wait().await;
        let mut conn = match ctx_bg.redis_client.get_multiplexed_async_connection().await {
            Ok(c) => c,
            Err(_) => return,
        };
        // A SIGTERM-induced exit reports as a failed exit status in Unix
        // semantics even though it's exactly what `stop_executor` asked
        // for — only treat an exit as an unexpected Error if the registry
        // wasn't already in Stopping when the process died.
        let was_requested_stop = ctx_bg
            .registry
            .get(&user_id_bg)
            .map(|s| s.status == BotStatus::Stopping)
            .unwrap_or(false);

        let (status, error) = match exit {
            Ok(status) if status.success() || was_requested_stop => (BotStatus::Stopped, None),
            Ok(status) => (BotStatus::Error, Some(format!("exited with {status}"))),
            Err(e) => (BotStatus::Error, Some(format!("wait failed: {e}"))),
        };

        let (crash_count, retry_payload) =
            if let Some(mut entry) = ctx_bg.registry.get_mut(&user_id_bg) {
                entry.status = status;
                entry.pid = None;
                entry.last_error = error.clone();
                (entry.consecutive_crash_count, entry.last_payload.clone())
            } else {
                (consecutive_crash_count, None)
            };

        publish_event(
            &mut conn,
            &BotEvent::Status {
                user_id: user_id_bg.clone(),
                status,
                at: now_iso(),
            },
        )
        .await;
        if let Some(message) = error {
            publish_event(
                &mut conn,
                &BotEvent::Error {
                    user_id: user_id_bg.clone(),
                    message,
                    at: now_iso(),
                },
            )
            .await;
        }

        // Auto-restart an unexpected crash — never an explicitly requested
        // stop, never a clean exit — so a transient failure (a dropped RPC
        // connection, a momentary Redis blip) doesn't strand the user with
        // a bot that silently stopped until they notice and click Start
        // again.
        if status == BotStatus::Error && !was_requested_stop {
            if crash_count < MAX_CONSECUTIVE_CRASHES {
                if let Some(payload) = retry_payload {
                    let delay = restart_backoff(crash_count);
                    tracing::warn!(
                        %user_id_bg,
                        crash_count,
                        delay_secs = delay.as_secs(),
                        "executor: unexpected exit, auto-restarting"
                    );
                    tokio::time::sleep(delay).await;
                    if let Err(status_code) =
                        spawn_executor(ctx_bg.clone(), user_id_bg.clone(), payload, crash_count + 1)
                    {
                        tracing::error!(%user_id_bg, ?status_code, "executor: auto-restart failed to spawn");
                    }
                }
            } else {
                tracing::error!(
                    %user_id_bg,
                    crash_count,
                    "executor: giving up after repeated crashes, staying stopped"
                );
            }
        }
    });

    Ok(())
}

async fn start_executor(
    State(ctx): State<Arc<AppCtx>>,
    Path(user_id): Path<String>,
    headers: HeaderMap,
    Json(payload): Json<ExecutorStartPayload>,
) -> Result<Json<ExecutorStatusView>, StatusCode> {
    check_auth(&ctx, &headers)?;
    if payload.user_id != user_id {
        return Err(StatusCode::BAD_REQUEST);
    }

    // Starting again while already running is a restart: stop the old
    // process first so we never have two executors for the same user.
    if let Some(existing) = ctx.registry.get(&user_id) {
        if matches!(existing.status, BotStatus::Running | BotStatus::Starting) {
            if let Some(pid) = existing.pid {
                let _ = tokio::process::Command::new("kill")
                    .args(["-TERM", &pid.to_string()])
                    .status()
                    .await;
            }
        }
    }

    // An explicit start always resets the crash-backoff counter — the user
    // asking for this is itself a fresh attempt, not a continuation of
    // whatever crash loop (if any) preceded it.
    spawn_executor(ctx.clone(), user_id.clone(), payload, 0)?;

    let view = to_view(&user_id, &ctx.registry.get(&user_id).unwrap());
    Ok(Json(view))
}

async fn stop_executor(
    State(ctx): State<Arc<AppCtx>>,
    Path(user_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<ExecutorStatusView>, StatusCode> {
    check_auth(&ctx, &headers)?;

    let pid = ctx.registry.get(&user_id).and_then(|s| s.pid);
    if let Some(pid) = pid {
        let _ = tokio::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .await;
        if let Some(mut entry) = ctx.registry.get_mut(&user_id) {
            entry.status = BotStatus::Stopping;
            // An explicit stop is never auto-restarted (the exit-monitor's
            // was_requested_stop check already guarantees that), so there's
            // no more use for the decrypted wallet secret this holds —
            // drop it rather than let it linger in memory.
            entry.last_payload = None;
        }
    } else if let Some(mut entry) = ctx.registry.get_mut(&user_id) {
        entry.status = BotStatus::Stopped;
        entry.last_payload = None;
    } else {
        ctx.registry
            .insert(user_id.clone(), ExecutorState::default());
    }

    let view = to_view(&user_id, &ctx.registry.get(&user_id).unwrap());
    Ok(Json(view))
}

async fn get_status(
    State(ctx): State<Arc<AppCtx>>,
    Path(user_id): Path<String>,
    headers: HeaderMap,
) -> Result<Json<ExecutorStatusView>, StatusCode> {
    check_auth(&ctx, &headers)?;
    let state = ctx
        .registry
        .get(&user_id)
        .map(|s| s.clone())
        .unwrap_or_default();
    Ok(Json(to_view(&user_id, &state)))
}

async fn list_executors(
    State(ctx): State<Arc<AppCtx>>,
    headers: HeaderMap,
) -> Result<Json<Vec<ExecutorStatusView>>, StatusCode> {
    check_auth(&ctx, &headers)?;
    let views: Vec<_> = ctx
        .registry
        .iter()
        .map(|entry| to_view(entry.key(), entry.value()))
        .collect();
    Ok(Json(views))
}

fn env_var(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "engine_bridge=info,tower_http=info".into()),
        )
        .json()
        .init();

    let internal_token = std::env::var("ENGINE_BRIDGE_INTERNAL_TOKEN")
        .unwrap_or_else(|_| "dev-only-change-me".to_string());
    let redis_url = env_var("REDIS_URL", "redis://localhost:6379");
    let redis_client = redis::Client::open(redis_url)?;

    let executor_bin_path = std::env::current_exe()?.with_file_name(if cfg!(windows) {
        "executor.exe"
    } else {
        "executor"
    });

    let ctx = Arc::new(AppCtx {
        registry: DashMap::new(),
        internal_token,
        executor_bin_path,
        redis_client,
    });

    // Executors self-report Starting/Running/Error over their own Redis
    // event channel — without this, the registry would only ever learn
    // "Starting" (set at spawn) or the terminal exit state, with no way to
    // see that a process actually reached Running in between. This is
    // what makes GET /internal/executors reflect live reality, not just
    // spawn/exit.
    {
        let ctx = ctx.clone();
        tokio::spawn(async move {
            loop {
                match ctx.redis_client.get_async_pubsub().await {
                    Ok(mut pubsub) => {
                        if pubsub.psubscribe("executor:events:*").await.is_err() {
                            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                            continue;
                        }
                        let mut stream = pubsub.on_message();
                        while let Some(msg) = stream.next().await {
                            let Ok(payload) = msg.get_payload::<String>() else {
                                continue;
                            };
                            let Ok(event) = serde_json::from_str::<BotEvent>(&payload) else {
                                continue;
                            };
                            let user_id = match &event {
                                BotEvent::Status { user_id, .. }
                                | BotEvent::Opportunity { user_id, .. }
                                | BotEvent::Trade { user_id, .. }
                                | BotEvent::Error { user_id, .. } => user_id.clone(),
                            };
                            let mut entry = ctx.registry.entry(user_id).or_default();
                            entry.last_event_at = Some(now_iso());
                            match event {
                                BotEvent::Status { status, .. } => {
                                    entry.status = status;
                                    // Reaching Running is the signal that
                                    // this attempt actually worked — clears
                                    // the crash counter so a later
                                    // unrelated crash gets the full retry
                                    // budget again instead of inheriting
                                    // an old streak.
                                    if status == BotStatus::Running {
                                        entry.consecutive_crash_count = 0;
                                    }
                                }
                                BotEvent::Error { message, .. } => entry.last_error = Some(message),
                                _ => {}
                            }
                        }
                    }
                    Err(_) => {
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                    }
                }
            }
        });
    }

    let app = Router::new()
        .route("/health", get(health))
        .route("/version", get(version))
        .route("/internal/executors", get(list_executors))
        .route("/internal/executors/:userId/start", post(start_executor))
        .route("/internal/executors/:userId/stop", post(stop_executor))
        .route("/internal/executors/:userId", get(get_status))
        .layer(tower_http::trace::TraceLayer::new_for_http())
        .with_state(ctx);

    let port: u16 = std::env::var("ENGINE_BRIDGE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8090);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    tracing::info!(%addr, "engine-bridge orchestrator listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
