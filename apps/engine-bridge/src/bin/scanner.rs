//! The shared, singleton detection process. Exactly one instance ever runs
//! (an operational invariant enforced by the orchestrator/deployment, not
//! by this binary) — republishes every parsed trade as a `ScannerTick` on a
//! Redis Stream that any number of `executor` processes can tail
//! independently. This is what keeps per-subscriber infra cost flat
//! instead of scaling with the number of users (see docs/ARCHITECTURE.md
//! §1, Décision A).
//!
//! Two data-source modes, auto-selected by environment — the rest of the
//! pipeline (CPI-log extraction, `parse_transaction_data`, `ScannerTick`
//! shape, Redis publish) is identical either way, so `engine-bridge`,
//! `executor`, and `apps/api` never see a difference:
//!
//! - **Production** (`YELLOWSTONE_GRPC_HTTP` set): subscribes once to
//!   Yellowstone gRPC for the watched DEX programs. Full transaction data
//!   (including inner instructions) is pushed at `Processed` commitment,
//!   no extra round trip per detection. This is what the original
//!   implementation always did — unchanged behavior, just refactored into
//!   `run_yellowstone()` below and sharing `detect_trade()`/`publish_tick()`
//!   with the mode below instead of inlining that logic in `main()`.
//! - **Development** (`YELLOWSTONE_GRPC_HTTP` unset): standard Solana
//!   JSON-RPC — `logsSubscribe` on each watched program via
//!   `SOLANA_WS_URL`, then `getTransaction` via `RPC_HTTP` for whatever
//!   `logsSubscribe` doesn't include (inner instructions, token balances).
//!   Exists so this project can be developed and tested against Chainstack
//!   (or any provider)'s free/standard RPC+WS tier without also paying for
//!   a Yellowstone gRPC add-on. **Materially higher latency and lower
//!   throughput than production — see the module-level warning logged at
//!   startup, and the doc comment on `run_rpc_websocket` below. Not meant
//!   to run against real capital.**
//!
//! Reuses exactly one function from the untouched engine crate:
//! `transaction_parser::parse_transaction_data`. It never calls
//! execute_buy/execute_sell or touches the engine's position-tracking
//! globals — this process makes no trading decisions, it only observes.
//! Development mode hand-assembles a `SubscribeUpdateTransaction` (the
//! Yellowstone protobuf type this function is typed against) from a
//! standard `getTransaction` response instead of receiving one over gRPC —
//! `parse_transaction_data` only ever reads `meta.log_messages` and
//! `meta.post_token_balances` from it (verified by inspection, not
//! assumed), both of which a standard RPC response also provides, so this
//! doesn't require touching `engine/` at all.

use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use engine_bridge::contract::{ScannerTick, SCANNER_TICKS_STREAM};
use futures_util::stream::select_all;
use futures_util::{SinkExt, StreamExt};
use redis::AsyncCommands;
use solana_client::nonblocking::pubsub_client::PubsubClient;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_client::rpc_config::{
    RpcTransactionConfig, RpcTransactionLogsConfig, RpcTransactionLogsFilter,
};
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::signature::Signature;
use solana_transaction_status::{
    EncodedConfirmedTransactionWithStatusMeta, UiInnerInstructions, UiInstruction,
    UiTransactionEncoding, UiTransactionStatusMeta, UiTransactionTokenBalance,
};
use solana_vntr_sniper::dex::pump_fun::PUMP_FUN_PROGRAM;
use solana_vntr_sniper::dex::pump_swap::PUMP_SWAP_PROGRAM;
use solana_vntr_sniper::dex::raydium_launchpad::RAYDIUM_LAUNCHPAD_PROGRAM;
use solana_vntr_sniper::processor::transaction_parser::{
    parse_transaction_data, TradeInfoFromToken,
};
use tokio::sync::{Mutex, Semaphore};
use yellowstone_grpc_client::{ClientTlsConfig, GeyserGrpcClient};
use yellowstone_grpc_proto::geyser::{
    subscribe_update::UpdateOneof, CommitmentLevel, SubscribeRequest,
    SubscribeRequestFilterTransactions, SubscribeRequestPing, SubscribeUpdateTransaction,
    SubscribeUpdateTransactionInfo,
};
use yellowstone_grpc_proto::solana::storage::confirmed_block::{
    InnerInstruction, InnerInstructions, Message, TokenBalance, Transaction, TransactionStatusMeta,
    UiTokenAmount,
};

type RedisConn = Arc<Mutex<redis::aio::MultiplexedConnection>>;

fn env(key: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| panic!("scanner: missing required env var {key}"))
}

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "scanner=info".into()),
        )
        .json()
        .init();

    let redis_url = env("REDIS_URL");
    let redis_client = redis::Client::open(redis_url)?;
    acquire_singleton_lock_or_exit(&redis_client).await;
    let redis_conn: RedisConn = Arc::new(Mutex::new(
        redis_client.get_multiplexed_async_connection().await?,
    ));

    // Mode is auto-selected, not configured separately: YELLOWSTONE_GRPC_HTTP
    // set -> production; unset -> development. One less setting to keep in
    // sync, and a deploy that forgets to set it fails loud in dev mode's own
    // startup warning rather than silently running degraded in production.
    match env_opt("YELLOWSTONE_GRPC_HTTP") {
        Some(yellowstone_grpc_http) => {
            tracing::info!(
                "scanner: YELLOWSTONE_GRPC_HTTP is set — production mode (Yellowstone gRPC)"
            );
            run_yellowstone(
                yellowstone_grpc_http,
                env("YELLOWSTONE_GRPC_TOKEN"),
                redis_conn,
            )
            .await
        }
        None => {
            tracing::warn!(
                "scanner: YELLOWSTONE_GRPC_HTTP not set — DEVELOPMENT MODE (RPC_HTTP + \
                 SOLANA_WS_URL, logsSubscribe + getTransaction). Materially higher latency than \
                 Yellowstone (waits for `confirmed` commitment, not `processed`, plus one \
                 getTransaction round trip per detection) and consumes your RPC provider's \
                 request quota per detected trade. Expect to miss fast-moving opportunities \
                 under load. Not intended to run against real capital — see this file's module \
                 doc comment."
            );
            let solana_ws_url = env("SOLANA_WS_URL");
            log_redacted_ws_url(&solana_ws_url);
            run_rpc_websocket(env("RPC_HTTP"), solana_ws_url, redis_conn).await
        }
    }
}

const SINGLETON_LOCK_KEY: &str = "scanner:singleton-lock";
const SINGLETON_LOCK_TTL_MS: usize = 30_000;
const SINGLETON_LOCK_RENEW_INTERVAL: Duration = Duration::from_secs(10);

/// Enforces, in code, the "exactly one scanner instance" invariant this
/// file's module doc has always documented but never mechanically checked.
/// A second instance — a stale process a previous redeploy failed to kill,
/// a PM2 config accidentally set to more than one instance, ... — doubles
/// every RPC request this process makes (its own 3x `logsSubscribe` plus
/// its own full `getTransaction` fan-out), consuming twice the RPS budget
/// for reasons completely invisible from either single instance's own
/// logs. Refuses to start rather than silently running duplicated.
async fn acquire_singleton_lock_or_exit(redis_client: &redis::Client) {
    let instance_id = format!(
        "{}-{}",
        std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown-host".to_string()),
        std::process::id()
    );

    let mut conn = match redis_client.get_multiplexed_async_connection().await {
        Ok(c) => c,
        Err(e) => {
            tracing::error!(
                error = %e,
                "scanner: could not reach Redis to acquire the singleton lock — refusing to \
                 start blind rather than risk running as an undetected duplicate instance"
            );
            std::process::exit(1);
        }
    };

    let acquired: bool = redis::cmd("SET")
        .arg(SINGLETON_LOCK_KEY)
        .arg(&instance_id)
        .arg("NX")
        .arg("PX")
        .arg(SINGLETON_LOCK_TTL_MS)
        .query_async::<Option<String>>(&mut conn)
        .await
        .map(|v| v.is_some())
        .unwrap_or(false);

    if !acquired {
        let holder: String = conn
            .get(SINGLETON_LOCK_KEY)
            .await
            .unwrap_or_else(|_| "<unknown>".to_string());
        tracing::error!(
            this_instance = %instance_id,
            held_by = %holder,
            "scanner: ANOTHER INSTANCE ALREADY HOLDS THE SINGLETON LOCK — refusing to start. \
             Running two scanners against the same RPC/WSS API key doubles every request this \
             process makes, which can exhaust an RPS budget for reasons invisible in a single \
             instance's own logs (e.g. logsSubscribe rejected with -32005 from the very first \
             attempt, with no other explanation in sight). Check for a stale process a previous \
             redeploy failed to kill, or a process manager config accidentally running more \
             than one instance."
        );
        std::process::exit(1);
    }

    tracing::info!(instance_id = %instance_id, "scanner: singleton lock acquired");

    // Renewed for as long as this process is alive; an abrupt crash/kill
    // just lets the TTL lapse instead of requiring any explicit release,
    // so a dead instance can't permanently deadlock a fresh one.
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SINGLETON_LOCK_RENEW_INTERVAL);
        loop {
            interval.tick().await;
            let _: redis::RedisResult<()> = redis::cmd("SET")
                .arg(SINGLETON_LOCK_KEY)
                .arg(&instance_id)
                .arg("PX")
                .arg(SINGLETON_LOCK_TTL_MS)
                .query_async(&mut conn)
                .await;
        }
    });
}

/// Logs the *shape* of SOLANA_WS_URL — scheme, host, and how many path
/// segments it has — without ever logging the URL itself, so the secret
/// never ends up in log output. Exists to self-diagnose the most common
/// cause of Chainstack's WS handshake returning HTTP 401: Chainstack's
/// documented Solana WSS auth is the API key embedded as the LAST URL PATH
/// SEGMENT (e.g. `wss://ws-nd-XXX.p2pify.com/<KEY>` or
/// `wss://<network>.core.chainstack.com/<KEY>`) — it is not a header, not
/// Bearer, and not HTTP Basic Auth. `PubsubClient::new()` sends the full
/// URL path verbatim (verified by reading tokio-tungstenite's
/// `IntoClientRequest` impl), so a URL that already ends in `/<KEY>` works
/// fine through it; a URL with zero path segments (key left off, or a
/// plain `wss://ws-nd-XXX.p2pify.com` copied from the dashboard's "host"
/// field instead of its full endpoint URL) will authenticate as nobody and
/// is the first thing this rules in or out before assuming Chainstack has
/// its optional Basic-Auth "password protection" feature turned on instead
/// (a separate, less common cause `PubsubClient::new()` truly cannot
/// support — see `watch_program_logs`'s error-logging comment for what to
/// check if `path_segment_count` here is already correct).
fn log_redacted_ws_url(url: &str) {
    let (scheme, rest) = url.split_once("://").unwrap_or(("<no-scheme>", url));
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let has_userinfo = authority.contains('@');
    let path_segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    tracing::info!(
        scheme = %scheme,
        host = %host,
        has_userinfo,
        path_segment_count = path_segments.len(),
        last_path_segment_len = path_segments.last().map(|s| s.len()).unwrap_or(0),
        "scanner: SOLANA_WS_URL shape (redacted — no secret logged). If path_segment_count is 0, \
         that is almost certainly why Chainstack returns 401: no API key is present in the URL \
         at all. Compare against the full WSS endpoint URL shown in your Chainstack dashboard \
         (not just its hostname)."
    );
}

fn watched_programs() -> Vec<String> {
    vec![
        PUMP_FUN_PROGRAM.to_string(),
        PUMP_SWAP_PROGRAM.to_string(),
        RAYDIUM_LAUNCHPAD_PROGRAM.to_string(),
    ]
}

/// Same extraction pattern as the engine's own process_message_for_dex_monitoring:
/// the CPI log carrying the trade payload is the inner instruction whose data
/// length matches one of these known instruction encodings. Shared by both
/// modes: once a `SubscribeUpdateTransaction` exists — straight off
/// Yellowstone, or hand-assembled from a standard `getTransaction` response
/// (see `to_synthetic_subscribe_update` below) — the rest of the detection
/// pipeline is identical.
fn extract_cpi_log_data(txn: &SubscribeUpdateTransaction) -> Option<Vec<u8>> {
    let inner_instructions = txn
        .transaction
        .as_ref()
        .and_then(|t| t.meta.as_ref())
        .map(|m| m.inner_instructions.clone())
        .unwrap_or_default();

    inner_instructions
        .iter()
        .flat_map(|inner| &inner.instructions)
        .find(|ix| matches!(ix.data.len(), 368 | 266 | 270 | 146 | 170 | 138))
        .map(|ix| ix.data.clone())
}

/// Mirrors the engine's own (private-to-sniper_bot.rs) `extract_signer_from_
/// transaction`: by Solana convention the first account key in a message is
/// the transaction's fee payer, which is also its first required signer —
/// i.e. whoever actually submitted this trade. Works identically for both
/// modes because dev mode's `to_synthetic_subscribe_update` populates this
/// same field (with just that one key) from the real decoded transaction.
fn extract_trader_from_transaction(txn: &SubscribeUpdateTransaction) -> Option<String> {
    let first_account_key = txn
        .transaction
        .as_ref()?
        .transaction
        .as_ref()?
        .message
        .as_ref()?
        .account_keys
        .first()?;
    Some(bs58::encode(first_account_key).into_string())
}

fn to_scanner_tick(parsed: &TradeInfoFromToken, trader: Option<String>) -> ScannerTick {
    ScannerTick {
        dex_type: format!("{:?}", parsed.dex_type),
        slot: parsed.slot,
        signature: parsed.signature.clone(),
        pool_id: parsed.pool_id.clone(),
        mint: parsed.mint.clone(),
        timestamp: parsed.timestamp,
        is_buy: parsed.is_buy,
        price: parsed.price,
        is_reverse_when_pump_swap: parsed.is_reverse_when_pump_swap,
        coin_creator: parsed.coin_creator.clone(),
        sol_change: parsed.sol_change,
        token_change: parsed.token_change,
        liquidity: parsed.liquidity,
        virtual_sol_reserves: parsed.virtual_sol_reserves,
        virtual_token_reserves: parsed.virtual_token_reserves,
        trader,
    }
}

async fn publish_tick(redis_conn: &RedisConn, tick: ScannerTick) {
    let Ok(payload) = serde_json::to_string(&tick) else {
        tracing::warn!(signature = %tick.signature, "scanner: failed to serialize tick, dropping");
        return;
    };
    let mut conn = redis_conn.lock().await;
    let result: redis::RedisResult<String> = conn
        .xadd_maxlen(
            SCANNER_TICKS_STREAM,
            redis::streams::StreamMaxlen::Approx(200_000),
            "*",
            &[("data", payload)],
        )
        .await;
    match result {
        Ok(stream_id) => {
            tracing::debug!(
                signature = %tick.signature,
                mint = %tick.mint,
                stream_id = %stream_id,
                "scanner: EMITTED — tick published to Redis stream for engine-bridge/executor"
            );
        }
        Err(e) => {
            tracing::warn!(error = %e, signature = %tick.signature, "scanner: failed to publish tick");
        }
    }
}

/// Turns one detected transaction into a trade tick using exactly the
/// untouched engine's own parser. `None` for anything that isn't a
/// recognized trade (no matching CPI log, wrapped-SOL mint, etc.) — the
/// same filtering both modes already applied inline before this was
/// extracted out of `main()`. `log_signature` is diagnostic-only (a
/// display string identifying which transaction this call is for, so the
/// rejection-reason logs below can be correlated with the rest of the
/// pipeline's per-signature logs even when several are in flight
/// concurrently) — it plays no role in the detection logic itself.
fn detect_trade(txn: &SubscribeUpdateTransaction, log_signature: &str) -> Option<ScannerTick> {
    let Some(data) = extract_cpi_log_data(txn) else {
        tracing::debug!(
            signature = %log_signature,
            "scanner: REJECTED — no inner instruction with a recognized CPI-log data length \
             (368/266/270/146/170/138 bytes). Either this transaction doesn't actually touch \
             PumpFun/PumpSwap/Raydium Launchpad in a way that emits one of those instructions, \
             or the instruction shape doesn't match what this scanner recognizes."
        );
        return None;
    };

    let Some(parsed) = parse_transaction_data(txn, &data) else {
        tracing::debug!(
            signature = %log_signature,
            cpi_data_len = data.len(),
            "scanner: REJECTED — a recognized CPI-log length was found, but the engine's \
             parse_transaction_data() returned None for it (couldn't extract trade data from \
             this instruction)."
        );
        return None;
    };

    if parsed.mint == "So11111111111111111111111111111111111111112" {
        tracing::debug!(
            signature = %log_signature,
            "scanner: REJECTED — parsed mint is wrapped SOL, filtered out (not a real token trade)."
        );
        return None;
    }

    let trader = extract_trader_from_transaction(txn);
    if trader.is_none() {
        tracing::debug!(
            signature = %log_signature,
            "scanner: trader (fee payer) could not be extracted from this transaction — the \
             tick will still publish and be visible to the generic sniper heuristic, but it \
             cannot match any copy-trading target since there's no wallet to compare against."
        );
    }

    let tick = to_scanner_tick(&parsed, trader);
    tracing::debug!(
        signature = %log_signature,
        mint = %tick.mint,
        dex = %tick.dex_type,
        is_buy = tick.is_buy,
        trader = ?tick.trader,
        "scanner: ACCEPTED — trade detected"
    );
    Some(tick)
}

// ─────────────────────────────────────────────────────────────────────────
// Production mode: Yellowstone gRPC
// ─────────────────────────────────────────────────────────────────────────

/// Unchanged from before this file grew a second mode — same subscription,
/// same retry/heartbeat behavior, same "log and exit" ending. Only the
/// per-transaction handling changed shape, delegating to the
/// `detect_trade`/`publish_tick` helpers now shared with dev mode instead
/// of inlining the same logic twice.
async fn run_yellowstone(
    yellowstone_grpc_http: String,
    yellowstone_grpc_token: String,
    redis_conn: RedisConn,
) -> anyhow::Result<()> {
    tracing::info!("scanner: connecting to Yellowstone gRPC");
    let mut client = GeyserGrpcClient::build_from_shared(yellowstone_grpc_http)?
        .x_token::<String>(Some(yellowstone_grpc_token))?
        .tls_config(ClientTlsConfig::new().with_native_roots())?
        .connect()
        .await?;

    let mut retry_count = 0;
    const MAX_RETRIES: u32 = 3;
    let (subscribe_tx, mut stream) = loop {
        match client.subscribe().await {
            Ok(pair) => break pair,
            Err(e) => {
                retry_count += 1;
                if retry_count >= MAX_RETRIES {
                    anyhow::bail!("scanner: failed to subscribe after {MAX_RETRIES} attempts: {e}");
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    };
    let subscribe_tx = Arc::new(Mutex::new(subscribe_tx));

    let subscription_request = SubscribeRequest {
        transactions: maplit::hashmap! {
            "All".to_owned() => SubscribeRequestFilterTransactions {
                vote: Some(false),
                failed: Some(false),
                signature: None,
                account_include: watched_programs(),
                account_exclude: vec![],
                account_required: Vec::<String>::new(),
            }
        },
        commitment: Some(CommitmentLevel::Processed as i32),
        ..Default::default()
    };
    subscribe_tx.lock().await.send(subscription_request).await?;
    tracing::info!("scanner: subscribed, watching PumpFun / PumpSwap / Raydium Launchpad");

    // Keep the stream alive.
    let heartbeat_tx = subscribe_tx.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            let ping = SubscribeRequest {
                ping: Some(SubscribeRequestPing { id: 0 }),
                ..Default::default()
            };
            if heartbeat_tx.lock().await.send(ping).await.is_err() {
                break;
            }
        }
    });

    while let Some(msg_result) = stream.next().await {
        let msg = match msg_result {
            Ok(msg) => msg,
            Err(e) => {
                tracing::warn!(error = ?e, "scanner: stream error");
                continue;
            }
        };

        let Some(UpdateOneof::Transaction(txn)) = &msg.update_oneof else {
            continue;
        };

        let log_signature = txn
            .transaction
            .as_ref()
            .map(|t| bs58::encode(&t.signature).into_string())
            .unwrap_or_default();
        tracing::debug!(signature = %log_signature, "scanner: transaction update received (Yellowstone)");

        let Some(tick) = detect_trade(txn, &log_signature) else {
            continue;
        };

        let redis_conn = redis_conn.clone();
        tokio::spawn(async move {
            publish_tick(&redis_conn, tick).await;
        });
    }

    tracing::warn!("scanner: stream ended");
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────
// Development mode: standard Solana JSON-RPC (logsSubscribe + getTransaction)
// ─────────────────────────────────────────────────────────────────────────

/// A burst of near-simultaneous detections (common right after a popular
/// pool launches — exactly the moment this matters least being slow) could
/// otherwise fire dozens of concurrent `getTransaction` calls and blow
/// through the RPC plan's rate limit in one go. Bounds concurrent lookups
/// instead; excess detections simply wait their turn. Tune to whatever your
/// Chainstack (or other provider) plan's actual req/s allows — check your
/// dashboard, this isn't derived from anything provider-specific.
const MAX_CONCURRENT_LOOKUPS: usize = 8;

/// getTransaction only serves `confirmed`/`finalized` commitment (Solana's
/// JSON-RPC does not support `processed` for this method) — unlike
/// Yellowstone's `processed`-level push, a transaction just seen via
/// logsSubscribe is often not fetchable yet the instant its log arrives. A
/// short bounded retry covers the normal confirm delay; if it never lands
/// in time, the trade is skipped rather than blocking this task forever.
const GET_TRANSACTION_RETRIES: u32 = 5;
const GET_TRANSACTION_RETRY_DELAY: Duration = Duration::from_millis(400);

/// `MAX_CONCURRENT_LOOKUPS` bounds how many `getTransaction` calls can be
/// *in flight* at once, but says nothing about *rate* — 8 short-lived
/// requests completing and immediately being replaced by 8 more can easily
/// sustain triple digits of requests per second once PumpFun/PumpSwap/
/// Raydium Launchpad's real mainnet-wide volume (every trade on any of
/// those programs, not just tokens this deployment cares about) is
/// flowing through `logsSubscribe`, each with up to
/// `GET_TRANSACTION_RETRIES` attempts. Most providers — Chainstack
/// included — meter HTTP and WSS requests against the *same* per-API-key
/// budget, so a `getTransaction` flood exhausting that budget doesn't just
/// throttle itself: it also starves out the `logsSubscribe` reconnect
/// attempts below, which is what actually surfaces as "logsSubscribe
/// failed: RPS limit" even though `getTransaction` is the real source of
/// the load. This caps *dispatch rate*, independent of concurrency, so the
/// scanner stays under whatever the plan actually allows. Override via
/// `SCANNER_MAX_RPC_RPS` — default is deliberately conservative (well
/// under a typical 250 RPS plan) to leave headroom for the initial
/// `logsSubscribe` calls and any other consumer of the same API key (e.g.
/// apps/api's own RPC usage, if it shares a Chainstack project).
const DEFAULT_MAX_RPC_RPS: usize = 100;

/// A token bucket refilled once per second, capped at its own capacity —
/// not a sliding window, just "at most N acquisitions worth of budget
/// available in any given second, unused budget doesn't roll over." Good
/// enough to keep this scanner's own request rate under a provider's
/// limit without pulling in a rate-limiting crate for one call site.
struct RateLimiter {
    semaphore: Arc<Semaphore>,
}

impl RateLimiter {
    fn new(permits_per_second: usize) -> Arc<Self> {
        let semaphore = Arc::new(Semaphore::new(permits_per_second));
        let refill_target = semaphore.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            loop {
                interval.tick().await;
                let available = refill_target.available_permits();
                if available < permits_per_second {
                    refill_target.add_permits(permits_per_second - available);
                }
            }
        });
        Arc::new(Self { semaphore })
    }

    /// Waits for budget, then consumes it — the permit is deliberately
    /// never returned; the refill task above is what replenishes the
    /// bucket, not the caller finishing its request.
    async fn acquire(&self) {
        if let Ok(permit) = self.semaphore.clone().acquire_owned().await {
            permit.forget();
        }
    }
}

/// Runs one `logsSubscribe` per watched program (Solana's reference RPC
/// implementation's `mentions` filter only ever reliably supports a single
/// address per subscription — most providers, Chainstack included, follow
/// that same reference behavior) plus a bounded pool of `getTransaction`
/// follow-ups. See this file's module doc comment for the latency/quota
/// tradeoffs versus `run_yellowstone` above.
const RECONNECT_BASE_DELAY: Duration = Duration::from_secs(5);
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(60);
/// A connection that stays up at least this long is treated as a real
/// success — its next failure starts the backoff over from
/// `RECONNECT_BASE_DELAY` — rather than an instant-fail that should keep
/// backing off from wherever it left off.
const RECONNECT_HEALTHY_UPTIME: Duration = Duration::from_secs(30);

/// A small pseudo-random offset (no `rand` dependency needed for this) so
/// the 3 per-program reconnect tasks below don't retry in lockstep —
/// without it, all 3 start at the same instant and share the exact same
/// backoff schedule, so every retry cycle re-creates the same "3 requests
/// in the same instant" burst that (however small) is worth avoiding when
/// the account is already rate-limited.
fn jitter_ms(max_ms: u64) -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    u64::from(nanos) % max_ms.max(1)
}

async fn run_rpc_websocket(
    rpc_http: String,
    solana_ws_url: String,
    redis_conn: RedisConn,
) -> anyhow::Result<()> {
    let rpc_client = Arc::new(RpcClient::new(rpc_http));
    let lookup_limiter = Arc::new(Semaphore::new(MAX_CONCURRENT_LOOKUPS));
    let max_rpc_rps = env_opt("SCANNER_MAX_RPC_RPS")
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MAX_RPC_RPS);
    let rate_limiter = RateLimiter::new(max_rpc_rps);
    tracing::info!(
        max_rpc_rps,
        "scanner: getTransaction dispatch capped at this rate"
    );

    // One WebSocket connection, all 3 watched-program subscriptions
    // multiplexed over it — `PubsubClient::logs_subscribe` takes `&self`
    // specifically so multiple subscriptions CAN share one connection; the
    // previous version of this file missed that and opened one
    // `PubsubClient` (i.e. one full TCP+TLS+WS handshake) per program,
    // tripling both the connection count and the number of simultaneous
    // `logsSubscribe` requests fired at startup for no reason — 3 requests
    // landing in the same instant is a much easier way to trip a
    // provider's short-window burst limiter than 3 requests spread out
    // even by a few tens of milliseconds, and that kind of burst limit
    // wouldn't show up as a sustained RPS violation on a dashboard at all.
    let mut backoff = RECONNECT_BASE_DELAY;
    loop {
        let attempt_started = tokio::time::Instant::now();
        if let Err(e) = watch_all_programs(
            &solana_ws_url,
            rpc_client.clone(),
            redis_conn.clone(),
            lookup_limiter.clone(),
            rate_limiter.clone(),
        )
        .await
        {
            tracing::warn!(
                error = %e,
                delay_secs = backoff.as_secs(),
                "scanner: logsSubscribe stream(s) ended, reconnecting"
            );
        }

        tokio::time::sleep(backoff + Duration::from_millis(jitter_ms(1000))).await;
        backoff = if attempt_started.elapsed() >= RECONNECT_HEALTHY_UPTIME {
            RECONNECT_BASE_DELAY
        } else {
            (backoff * 2).min(RECONNECT_MAX_DELAY)
        };
    }
}

/// Opens exactly one `PubsubClient` (one WebSocket connection) and issues
/// one `logsSubscribe` per watched program on it (Solana's reference RPC
/// implementation's `mentions` filter only ever reliably supports a single
/// address per subscription — most providers, Chainstack included, follow
/// that same reference behavior, so 3 separate subscribe calls are still
/// required; only the underlying connection is shared). The 3 resulting
/// notification streams are merged into one so a single loop handles all
/// of them. Runs until the connection ends or errors, then returns —
/// `run_rpc_websocket`'s caller loop reconnects (and resubscribes all 3)
/// from scratch. Each detected (non-failed) log spawns its own bounded
/// `getTransaction` + parse + publish task so one slow lookup can't stall
/// the next log notification from being received.
async fn watch_all_programs(
    solana_ws_url: &str,
    rpc_client: Arc<RpcClient>,
    redis_conn: RedisConn,
    lookup_limiter: Arc<Semaphore>,
    rate_limiter: Arc<RateLimiter>,
) -> anyhow::Result<()> {
    // PubsubClientError's ConnectionError/WsError variants wrap the real
    // tokio-tungstenite error (DNS, TLS, a non-101 HTTP response i.e.
    // 401/403, malformed handshake, ...) in a bare tuple field with no
    // #[source]/#[from] — thiserror only wires those into the error chain
    // when explicitly annotated, so it's NOT reachable via .source(), and
    // the Display impl is a fixed string ("unable to connect to server")
    // that never mentions it either. `?` alone (or even Debug-formatting
    // an anyhow-wrapped version of it) loses that detail before it's ever
    // logged. Log the raw error's Debug — which does include it, since
    // #[derive(Debug)] doesn't care about thiserror's chain wiring — right
    // here, before it's converted to anyhow for this function's own
    // control flow.
    rate_limiter.acquire().await;
    let pubsub = match PubsubClient::new(solana_ws_url).await {
        Ok(client) => client,
        Err(e) => {
            tracing::error!(
                url = %solana_ws_url,
                error_display = %e,
                error_debug = ?e,
                "scanner: PubsubClient::new failed — error_debug has the real cause \
                 (DNS/TLS/HTTP status/handshake), error_display is a generic thiserror \
                 message that won't show it"
            );
            anyhow::bail!("PubsubClient::new failed: {e}");
        }
    };

    let mut tagged_streams = Vec::new();
    for program in watched_programs() {
        // Each of the 3 calls is its own JSON-RPC request over the ONE
        // connection above — still rate-limited individually, since the
        // provider counts them as 3 requests regardless of the shared
        // socket.
        rate_limiter.acquire().await;
        let subscribe_result = pubsub
            .logs_subscribe(
                RpcTransactionLogsFilter::Mentions(vec![program.clone()]),
                RpcTransactionLogsConfig {
                    commitment: Some(CommitmentConfig::processed()),
                },
            )
            .await;
        match subscribe_result {
            Ok((stream, _unsubscribe)) => {
                let tagged = stream.map(move |update| (program.clone(), update));
                tagged_streams.push(tagged.boxed());
            }
            Err(e) => {
                tracing::error!(
                    url = %solana_ws_url,
                    program = %program,
                    error_display = %e,
                    error_debug = ?e,
                    "scanner: logs_subscribe failed — see error_debug for the real cause"
                );
                anyhow::bail!("logs_subscribe failed for {program}: {e}");
            }
        }
    }

    let mut merged = select_all(tagged_streams);

    while let Some((program, update)) = merged.next().await {
        tracing::debug!(
            program = %program,
            signature = %update.value.signature,
            err = ?update.value.err,
            "scanner: logsNotification received"
        );

        if update.value.err.is_some() {
            tracing::debug!(
                program = %program,
                signature = %update.value.signature,
                "scanner: REJECTED — transaction failed on-chain (err present in the \
                 notification), never worth a getTransaction lookup"
            );
            continue; // matches the Yellowstone filter's `failed: Some(false)`
        }
        let Ok(signature) = Signature::from_str(&update.value.signature) else {
            tracing::warn!(
                program = %program,
                raw_signature = %update.value.signature,
                "scanner: REJECTED — logsNotification signature failed to parse as a Signature"
            );
            continue;
        };
        tracing::debug!(
            program = %program,
            %signature,
            "scanner: signature accepted, dispatching getTransaction lookup"
        );

        let rpc_client = rpc_client.clone();
        let redis_conn = redis_conn.clone();
        let lookup_limiter = lookup_limiter.clone();
        let rate_limiter = rate_limiter.clone();
        tokio::spawn(async move {
            let Ok(_permit) = lookup_limiter.acquire().await else {
                return;
            };
            if let Some(tick) = fetch_and_detect(&rpc_client, signature, &rate_limiter).await {
                publish_tick(&redis_conn, tick).await;
            }
        });
    }

    anyhow::bail!("logs_subscribe stream(s) closed")
}

/// Fetches the full transaction via `getTransaction` (retrying through the
/// normal confirm delay — see `GET_TRANSACTION_RETRIES`'s doc comment),
/// then runs it through the exact same `detect_trade` pipeline Yellowstone
/// mode uses. Every attempt — including retries — goes through
/// `rate_limiter` first: a signature that needs all 5 attempts to confirm
/// would otherwise burst 5 requests regardless of the configured RPS cap.
async fn fetch_and_detect(
    rpc_client: &RpcClient,
    signature: Signature,
    rate_limiter: &RateLimiter,
) -> Option<ScannerTick> {
    let mut confirmed: Option<EncodedConfirmedTransactionWithStatusMeta> = None;
    for attempt in 0..GET_TRANSACTION_RETRIES {
        let config = RpcTransactionConfig {
            encoding: Some(UiTransactionEncoding::Base64),
            commitment: Some(CommitmentConfig::confirmed()),
            max_supported_transaction_version: Some(0),
        };
        rate_limiter.acquire().await;
        tracing::debug!(%signature, attempt, "scanner: calling getTransaction");
        match rpc_client
            .get_transaction_with_config(&signature, config)
            .await
        {
            Ok(tx) => {
                tracing::debug!(%signature, attempt, slot = tx.slot, "scanner: getTransaction succeeded");
                confirmed = Some(tx);
                break;
            }
            Err(e) if attempt + 1 < GET_TRANSACTION_RETRIES => {
                tracing::debug!(error = %e, %signature, attempt, "scanner: getTransaction not ready yet, retrying");
                tokio::time::sleep(GET_TRANSACTION_RETRY_DELAY).await;
            }
            Err(e) => {
                tracing::warn!(error = %e, %signature, "scanner: getTransaction failed, giving up on this signature");
            }
        }
    }

    let Some(confirmed) = confirmed else {
        tracing::debug!(
            %signature,
            "scanner: REJECTED — getTransaction never succeeded after {GET_TRANSACTION_RETRIES} \
             attempts"
        );
        return None;
    };

    let signature_str = signature.to_string();
    let Some(txn) = to_synthetic_subscribe_update(confirmed, &signature_str) else {
        tracing::debug!(
            %signature,
            "scanner: REJECTED — to_synthetic_subscribe_update returned None (the confirmed \
             transaction had no meta at all, an unusual/malformed RPC response)"
        );
        return None;
    };

    detect_trade(&txn, &signature_str)
}

/// Hand-assembles a Yellowstone-shaped `SubscribeUpdateTransaction` from a
/// standard `getTransaction` response, populating only the fields
/// `parse_transaction_data`/`extract_cpi_log_data` actually read
/// (`meta.log_messages`, `meta.post_token_balances`, `meta.inner_instructions`
/// — verified by inspecting `engine/src/processor/transaction_parser.rs`,
/// not assumed). Everything else is left at its zero value; `engine/` never
/// reads it, so it never needs to be right.
fn to_synthetic_subscribe_update(
    confirmed: EncodedConfirmedTransactionWithStatusMeta,
    log_signature: &str,
) -> Option<SubscribeUpdateTransaction> {
    // The only reason this decodes the full transaction (rather than only
    // reading `meta`, like the rest of this function) is to recover the fee
    // payer for copy-trading matching — `EncodedTransaction::decode()`
    // rejects anything that doesn't pass `VersionedTransaction::sanitize()`,
    // so a `None` here (malformed/unexpected encoding) just means this tick
    // won't match any copy-trading target; it never blocks detection itself.
    let decoded = confirmed.transaction.transaction.decode();
    tracing::debug!(
        signature = %log_signature,
        decoded = decoded.is_some(),
        "scanner: transaction decode (for fee-payer extraction) result"
    );
    let fee_payer_account_keys: Vec<Vec<u8>> = decoded
        .and_then(|versioned_tx| {
            versioned_tx
                .message
                .static_account_keys()
                .first()
                .map(|fee_payer| vec![fee_payer.to_bytes().to_vec()])
        })
        .unwrap_or_default();

    let meta: UiTransactionStatusMeta = confirmed.transaction.meta?;

    let log_messages: Vec<String> = Option::from(meta.log_messages).unwrap_or_default();

    let post_token_balances: Vec<TokenBalance> =
        Option::<Vec<UiTransactionTokenBalance>>::from(meta.post_token_balances)
            .unwrap_or_default()
            .into_iter()
            .map(|b: UiTransactionTokenBalance| TokenBalance {
                account_index: u32::from(b.account_index),
                mint: b.mint,
                ui_token_amount: Some(UiTokenAmount {
                    ui_amount: b.ui_token_amount.ui_amount.unwrap_or_default(),
                    decimals: u32::from(b.ui_token_amount.decimals),
                    amount: b.ui_token_amount.amount,
                    ui_amount_string: b.ui_token_amount.ui_amount_string,
                }),
                owner: String::new(),
                program_id: String::new(),
            })
            .collect();

    let inner_instructions: Vec<InnerInstructions> =
        Option::<Vec<UiInnerInstructions>>::from(meta.inner_instructions)
            .unwrap_or_default()
            .into_iter()
            .map(|group| InnerInstructions {
                index: u32::from(group.index),
                instructions: group
                    .instructions
                    .into_iter()
                    .filter_map(|ix| match ix {
                        UiInstruction::Compiled(compiled) => {
                            let data = bs58::decode(&compiled.data).into_vec().ok()?;
                            Some(InnerInstruction {
                                program_id_index: u32::from(compiled.program_id_index),
                                accounts: compiled.accounts,
                                data,
                                stack_height: compiled.stack_height,
                            })
                        }
                        // jsonParsed encoding would produce this variant instead —
                        // deliberately not requested (see fetch_and_detect's
                        // UiTransactionEncoding::Base64), so this arm should
                        // never actually hit; kept as a safe no-op rather than a
                        // panic in case a provider ever behaves unexpectedly.
                        UiInstruction::Parsed(_) => None,
                    })
                    .collect(),
            })
            .collect();

    Some(SubscribeUpdateTransaction {
        slot: confirmed.slot,
        transaction: Some(SubscribeUpdateTransactionInfo {
            signature: Vec::new(),
            is_vote: false,
            transaction: Some(Transaction {
                signatures: Vec::new(),
                message: Some(Message {
                    account_keys: fee_payer_account_keys,
                    ..Default::default()
                }),
            }),
            meta: Some(TransactionStatusMeta {
                log_messages,
                post_token_balances,
                inner_instructions,
                ..Default::default()
            }),
            index: 0,
        }),
    })
}
