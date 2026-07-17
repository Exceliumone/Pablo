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
use engine_bridge::contract::{
    BotEvent, BotStatus, ExecutorStartPayload, ExecutorStatusView,
};
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
    restart_count: u32,
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

    let payload_json = serde_json::to_string(&payload).map_err(|_| StatusCode::BAD_REQUEST)?;

    let mut child = tokio::process::Command::new(&ctx.executor_bin_path)
        .env("EXECUTOR_CONFIG_JSON", payload_json)
        .env("RUST_LOG", "info")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            tracing::error!(error = %e, "failed to spawn executor");
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
        if let Some(mut entry) = ctx_bg.registry.get_mut(&user_id_bg) {
            entry.status = status;
            entry.pid = None;
            entry.last_error = error.clone();
        }
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
                    user_id: user_id_bg,
                    message,
                    at: now_iso(),
                },
            )
            .await;
        }
    });

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
        }
    } else if let Some(mut entry) = ctx.registry.get_mut(&user_id) {
        entry.status = BotStatus::Stopped;
    } else {
        ctx.registry.insert(user_id.clone(), ExecutorState::default());
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
    let state = ctx.registry.get(&user_id).map(|s| s.clone()).unwrap_or_default();
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
                            let Ok(payload) = msg.get_payload::<String>() else { continue };
                            let Ok(event) = serde_json::from_str::<BotEvent>(&payload) else { continue };
                            let user_id = match &event {
                                BotEvent::Status { user_id, .. }
                                | BotEvent::Opportunity { user_id, .. }
                                | BotEvent::Trade { user_id, .. }
                                | BotEvent::Error { user_id, .. } => user_id.clone(),
                            };
                            let mut entry = ctx.registry.entry(user_id).or_default();
                            entry.last_event_at = Some(now_iso());
                            match event {
                                BotEvent::Status { status, .. } => entry.status = status,
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
