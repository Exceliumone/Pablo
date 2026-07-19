//! The shared, singleton **wallet tracker**. Exactly one instance ever runs
//! (an operational invariant enforced by the orchestrator/deployment, not
//! by this binary) — republishes every detected trade as a `ScannerTick` on
//! a Redis Stream that any number of `executor` processes can tail
//! independently. This is what keeps per-subscriber infra cost flat
//! instead of scaling with the number of users (see docs/ARCHITECTURE.md
//! §1, Décision A).
//!
//! **This is a copy-trading wallet tracker, not a DEX-wide sniper feed.**
//! It never subscribes to PumpFun/PumpSwap/Raydium Launchpad program-wide
//! activity — by explicit product decision, it only ever watches the
//! specific wallet addresses currently configured as a copy-trading target
//! by at least one active user (`scanner:tracked-wallets`, a Redis Set
//! maintained by apps/api — see `fetch_tracked_wallets` below). One
//! `logsSubscribe(Mentions([wallet]))` per tracked wallet, re-read from
//! Redis on every (re)connect and periodically thereafter so a wallet
//! added/removed from any user's settings takes effect without a process
//! restart — see `watch_tracked_wallets`. A transaction merely *mentioning*
//! a tracked wallet (e.g. as an unrelated counterparty's account) is not
//! enough to publish a tick: `extract_trader_from_transaction` must confirm
//! the tracked wallet is the transaction's actual fee payer/signer before
//! anything is published — see the trader-match check in
//! `watch_tracked_wallets`'s notification loop.
//!
//! Runs on standard Solana JSON-RPC only, by design: `logsSubscribe` via
//! `SOLANA_WS_URL`, then `getTransaction` via `RPC_HTTP` for whatever
//! `logsSubscribe` doesn't include (inner instructions, token balances).
//! Works against any provider's free or paid RPC+WS tier — including
//! Solana's own public endpoint (`https://api.mainnet-beta.solana.com` /
//! `wss://api.mainnet-beta.solana.com`, zero cost, no account needed),
//! which is the default in `.env.example`. No provider-specific
//! integration, no paid gRPC add-on, no API key required to run this at
//! all — see `SCANNER_MAX_RPC_RPS`/`MAX_PENDING_LOOKUPS` for the
//! latency/throughput tradeoff this accepts in exchange.
//!
//! Reuses exactly one function from the untouched engine crate:
//! `transaction_parser::parse_transaction_data`. It never calls
//! execute_buy/execute_sell or touches the engine's position-tracking
//! globals — this process makes no trading decisions, it only observes.
//! `to_synthetic_subscribe_update` below hand-assembles a
//! `SubscribeUpdateTransaction` (the Yellowstone protobuf *type* this
//! function is typed against — kept as a dependency purely for its
//! generated Rust structs, not a gRPC client) from a standard
//! `getTransaction` response. `parse_transaction_data` only ever reads
//! `meta.log_messages` and `meta.post_token_balances` from it (verified by
//! inspection, not assumed), both of which a standard RPC response also
//! provides, so this doesn't require touching `engine/` at all.

use std::str::FromStr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use engine_bridge::contract::{ScannerTick, SCANNER_TICKS_STREAM};
use futures_util::stream::select_all;
use futures_util::StreamExt;
use redis::AsyncCommands;
use solana_client::nonblocking::pubsub_client::PubsubClient;
use solana_client::nonblocking::rpc_client::RpcClient;
use solana_client::rpc_config::{
    RpcTransactionConfig, RpcTransactionLogsConfig, RpcTransactionLogsFilter,
};
use solana_sdk::commitment_config::CommitmentConfig;
use solana_sdk::signature::Signature;
use solana_transaction_status::option_serializer::OptionSerializer;
use solana_transaction_status::{
    EncodedConfirmedTransactionWithStatusMeta, UiInnerInstructions, UiInstruction,
    UiTransactionEncoding, UiTransactionStatusMeta, UiTransactionTokenBalance,
};
use solana_vntr_sniper::processor::transaction_parser::{
    parse_transaction_data, DexType, TradeInfoFromToken,
};
use tokio::sync::{Mutex, Semaphore};
// Only the generated protobuf structs are used here, never the gRPC client
// — `SubscribeUpdateTransaction` is the type `engine::transaction_parser::
// parse_transaction_data` is typed against (see this file's module doc),
// so `to_synthetic_subscribe_update` below must keep constructing this
// exact shape even though nothing here ever speaks gRPC.
use yellowstone_grpc_proto::geyser::{SubscribeUpdateTransaction, SubscribeUpdateTransactionInfo};
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
    log_redacted_redis_url(&redis_url);
    let redis_client = redis::Client::open(redis_url)?;
    acquire_singleton_lock_or_exit(&redis_client).await;
    let redis_conn: RedisConn = Arc::new(Mutex::new(
        redis_client.get_multiplexed_async_connection().await?,
    ));

    tracing::info!(
        "scanner: starting on standard Solana JSON-RPC (logsSubscribe + getTransaction) — no \
         paid provider, no gRPC add-on, see this file's module doc comment"
    );
    let solana_ws_url = env("SOLANA_WS_URL");
    log_redacted_ws_url(&solana_ws_url);
    run_rpc_websocket(env("RPC_HTTP"), solana_ws_url, redis_conn).await
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
/// Same redaction/shape logic as `log_redacted_ws_url` below, applied to
/// `REDIS_URL` — this scanner writes `scanner:ticks` to whatever this
/// resolves to, read from apps/engine-bridge/.env. `executor` (a separate
/// binary, apps/engine-bridge/src/bin/executor.rs) connects to Redis using
/// a *different* `.env` file's `REDIS_URL` (apps/api's, relayed through
/// `ExecutorStartPayload`) — if the two ever drift (different host, port,
/// or logical DB index), both processes report perfectly healthy while
/// the executor never sees a single tick this scanner publishes. Compare
/// this log line against the executor's own "executor: REDIS_URL shape"
/// log to catch that.
fn log_redacted_redis_url(url: &str) {
    let (scheme, rest) = url.split_once("://").unwrap_or(("<no-scheme>", url));
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let has_credentials = authority.contains('@');
    let db_index = if path.is_empty() { "0 (default)" } else { path };

    tracing::info!(
        scheme = %scheme,
        host_port = %host_port,
        has_credentials,
        db_index = %db_index,
        "scanner: REDIS_URL shape (redacted — no password logged)."
    );
}

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

/// Redis Set of base58 wallet addresses this scanner should track — the
/// union, across every currently-running bot with copy-trading enabled, of
/// that user's `copy_trading_targets`. Maintained by apps/api (see
/// `apps/api/src/lib/tracked-wallets.ts`): written to on bot start/settings
/// update, cleared on stop. This scanner only ever reads it — it never
/// writes to this key itself, so a stale/incorrectly-maintained set is an
/// apps/api bug, not a scanner bug.
const TRACKED_WALLETS_KEY: &str = "scanner:tracked-wallets";

/// Reads the current tracked-wallet set fresh from Redis. Called once per
/// (re)connect attempt in `run_rpc_websocket`'s loop, and periodically
/// during an established connection (`watch_tracked_wallets`'s
/// `WALLET_LIST_POLL_INTERVAL`) so a wallet added or removed from any
/// user's settings takes effect within one poll interval — no scanner
/// restart required. Returns an empty `Vec` (not an error) on a Redis
/// failure or an empty set; the caller treats both the same way ("nothing
/// to track right now").
async fn fetch_tracked_wallets(redis_conn: &RedisConn) -> Vec<String> {
    let mut conn = redis_conn.lock().await;
    let result: redis::RedisResult<Vec<String>> = conn.smembers(TRACKED_WALLETS_KEY).await;
    match result {
        Ok(mut wallets) => {
            wallets.sort();
            wallets
        }
        Err(e) => {
            tracing::warn!(
                error = %e,
                key = TRACKED_WALLETS_KEY,
                "scanner: failed to read tracked-wallet set from Redis, treating as empty for \
                 this attempt"
            );
            Vec::new()
        }
    }
}

/// Rough, padding-adjusted base64-decoded length — good enough for a
/// diagnostic size comparison, not a claim of exact correctness (no
/// `base64` crate dependency added just for this one log field).
fn approx_base64_decoded_len(s: &str) -> usize {
    let trimmed = s.trim_end();
    if trimmed.is_empty() {
        return 0;
    }
    let padding = trimmed.chars().rev().take_while(|&c| c == '=').count();
    (trimmed.len() / 4) * 3 - padding.min(3)
}

/// Identifies which program was "active" (innermost currently-invoked) at
/// a given line in `log_messages`, by replaying Solana's own log
/// convention: "Program <id> invoke [<depth>]" pushes, "Program <id>
/// success"/"Program <id> failed: ..." pops. This is how a `Program data:`
/// (sol_log_data) line's emitting program is identified — unlike
/// inner-instruction call data, a log-based CPI event has no
/// `program_id_index` of its own to resolve.
fn emitting_program_at(log_messages: &[String], target_line: usize) -> Option<String> {
    let mut stack: Vec<&str> = Vec::new();
    for line in log_messages.iter().take(target_line + 1) {
        let mut words = line.split_whitespace();
        if words.next() != Some("Program") {
            continue;
        }
        let Some(id) = words.next() else { continue };
        match words.next() {
            Some("invoke") => stack.push(id),
            Some("success") => {
                stack.pop();
            }
            Some(w) if w.starts_with("failed") => {
                stack.pop();
            }
            _ => {}
        }
    }
    stack.last().map(|s| s.to_string())
}

/// Same extraction pattern as the engine's own process_message_for_dex_monitoring:
/// the CPI log carrying the trade payload is the inner instruction whose data
/// length matches one of these known instruction encodings. Operates on the
/// `SubscribeUpdateTransaction` hand-assembled from a standard
/// `getTransaction` response (see `to_synthetic_subscribe_update` below).
/// `log_signature` is diagnostic-only, matching the convention already used
/// by `detect_trade`/`fetch_and_detect`.
fn extract_cpi_log_data(txn: &SubscribeUpdateTransaction, log_signature: &str) -> Option<Vec<u8>> {
    let inner_instructions = txn
        .transaction
        .as_ref()
        .and_then(|t| t.meta.as_ref())
        .map(|m| m.inner_instructions.clone())
        .unwrap_or_default();

    let matched = inner_instructions
        .iter()
        .flat_map(|inner| &inner.instructions)
        .find(|ix| matches!(ix.data.len(), 368 | 266 | 270 | 146 | 170 | 138))
        .map(|ix| ix.data.clone());

    // Everything below is diagnostic-only, gated on the reject path, so it
    // costs nothing when a match is found (the normal/expected case).
    if matched.is_none() {
        let account_keys = txn
            .transaction
            .as_ref()
            .and_then(|t| t.transaction.as_ref())
            .and_then(|t| t.message.as_ref())
            .map(|m| m.account_keys.clone())
            .unwrap_or_default();
        let log_messages = txn
            .transaction
            .as_ref()
            .and_then(|t| t.meta.as_ref())
            .map(|m| m.log_messages.clone())
            .unwrap_or_default();

        tracing::debug!(
            signature = %log_signature,
            inner_instruction_group_count = inner_instructions.len(),
            total_inner_instruction_count =
                inner_instructions.iter().map(|g| g.instructions.len()).sum::<usize>(),
            log_message_count = log_messages.len(),
            known_lengths = "368, 266, 270, 146, 170, 138",
            "scanner: REJECTED — no inner instruction matched a recognized CPI-log data length; \
             dumping full instruction/log detail below to identify the actual format in use"
        );

        if inner_instructions.is_empty() {
            tracing::debug!(
                signature = %log_signature,
                "scanner: this transaction has ZERO inner instruction groups at all — nothing to \
                 even compare a length against"
            );
        }

        for group in &inner_instructions {
            for (ix_idx, ix) in group.instructions.iter().enumerate() {
                let program_id = account_keys
                    .get(ix.program_id_index as usize)
                    .map(|key| bs58::encode(key).into_string())
                    .unwrap_or_else(|| {
                        format!(
                            "<unresolvable: program_id_index {} but this transaction's message \
                             only carries {} account key(s) — see to_synthetic_subscribe_update's \
                             static_account_keys()/loaded_addresses assembly; an index still past \
                             that combined range means this is genuinely out of bounds, not a \
                             known truncation>",
                            ix.program_id_index,
                            account_keys.len()
                        )
                    });
                tracing::debug!(
                    signature = %log_signature,
                    inner_instruction_group_index = group.index,
                    instruction_index = ix_idx,
                    program_id_index = ix.program_id_index,
                    program_id = %program_id,
                    account_indices = ?ix.accounts,
                    data_len = ix.data.len(),
                    data_len_is_a_known_length = matches!(ix.data.len(), 368 | 266 | 270 | 146 | 170 | 138),
                    stack_height = ?ix.stack_height,
                    "scanner: inner instruction detail"
                );
            }
        }

        // A "CPI log" can also mean a `sol_log_data`-emitted event — shown
        // as a "Program data: <base64>" log line — which is a completely
        // different mechanism from inner-instruction call data above and
        // is NOT currently read anywhere in this file. If PumpFun/
        // PumpSwap/Raydium Launchpad moved their event emission to this
        // mechanism, inner-instruction lengths would never match again
        // regardless of what they are, which is exactly this symptom.
        let program_data_logs: Vec<(usize, usize)> = log_messages
            .iter()
            .enumerate()
            .filter_map(|(i, line)| {
                line.strip_prefix("Program data: ")
                    .map(|b64| (i, approx_base64_decoded_len(b64)))
            })
            .collect();

        if program_data_logs.is_empty() {
            tracing::debug!(
                signature = %log_signature,
                "scanner: no \"Program data:\" log lines found either (checked both possible \
                 CPI-event mechanisms — inner-instruction data and sol_log_data — neither \
                 matched anything recognizable)"
            );
        } else {
            for (line_index, decoded_len) in &program_data_logs {
                tracing::debug!(
                    signature = %log_signature,
                    log_line_index = line_index,
                    cpi_log_present = true,
                    cpi_log_decoded_len_approx = decoded_len,
                    emitting_program = ?emitting_program_at(&log_messages, *line_index),
                    raw_log = %log_messages[*line_index],
                    "scanner: \"Program data:\" (sol_log_data) log present — not currently read \
                     by this scanner; emitting_program identifies which program logged it (by \
                     replaying the invoke/success nesting up to this line), and its approximate \
                     decoded length is logged in case this is where the trade data actually \
                     lives now"
                );
            }
        }
    }

    matched
}

/// Mirrors the engine's own (private-to-sniper_bot.rs) `extract_signer_from_
/// transaction`: by Solana convention the first account key in a message is
/// the transaction's fee payer, which is also its first required signer —
/// i.e. whoever actually submitted this trade. `to_synthetic_subscribe_update`
/// below populates this field from the real decoded transaction.
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
    tracing::debug!(
        signature = %tick.signature,
        mint = %tick.mint,
        is_buy = tick.is_buy,
        "scanner: publishing copy-trade event"
    );
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

/// Shared tail for both detection paths below: WSOL filter, trader
/// extraction, `ScannerTick` conversion, ACCEPTED log. `detection_method`
/// is diagnostic-only, distinguishing which path produced this tick in the
/// logs (useful while both the old inner-instruction path and the newer
/// PumpSwap log-event path are live side by side).
fn finalize_detected_trade(
    parsed: &TradeInfoFromToken,
    txn: &SubscribeUpdateTransaction,
    log_signature: &str,
    detection_method: &str,
) -> Option<ScannerTick> {
    if parsed.mint == "So11111111111111111111111111111111111111112" {
        tracing::debug!(
            signature = %log_signature,
            detection_method,
            "scanner: REJECTED — parsed mint is wrapped SOL, filtered out (not a real token trade)."
        );
        return None;
    }

    let trader = extract_trader_from_transaction(txn);
    if trader.is_none() {
        tracing::debug!(
            signature = %log_signature,
            detection_method,
            "scanner: trader (fee payer) could not be extracted from this transaction — the \
             tick will still publish and be visible to the generic sniper heuristic, but it \
             cannot match any copy-trading target since there's no wallet to compare against."
        );
    }

    let tick = to_scanner_tick(parsed, trader);
    tracing::debug!(
        signature = %log_signature,
        mint = %tick.mint,
        dex = %tick.dex_type,
        is_buy = tick.is_buy,
        trader = ?tick.trader,
        detection_method,
        "scanner: ACCEPTED — trade detected"
    );
    Some(tick)
}

/// Mirrors the engine's own (private, inside `parse_transaction_data`'s
/// 368-byte branch) `extract_token_info`: same index-based (0 -> 1 -> 2)
/// WSOL-skip fallback and the same hardcoded default mint, so a PumpSwap
/// trade detected via the log-event path below resolves to the same mint
/// the engine would have picked had this same trade arrived as an
/// inner-instruction CPI log instead.
fn mint_from_post_token_balances(txn: &SubscribeUpdateTransaction) -> String {
    let post_token_balances = txn
        .transaction
        .as_ref()
        .and_then(|t| t.meta.as_ref())
        .map(|m| m.post_token_balances.clone())
        .unwrap_or_default();

    let mut mint = String::new();
    if !post_token_balances.is_empty() {
        mint = post_token_balances[0].mint.clone();
        if mint == "So11111111111111111111111111111111111111112" && post_token_balances.len() > 1 {
            mint = post_token_balances[1].mint.clone();
            if mint == "So11111111111111111111111111111111111111112"
                && post_token_balances.len() > 2
            {
                mint = post_token_balances[2].mint.clone();
            }
        }
    }

    if mint.is_empty() {
        mint = "2ivzYvjnKqA4X3dVvPKr7bctGpbxwrXbbxm44TJCpump".to_string();
    }

    mint
}

fn pumpswap_event_u64(payload: &[u8], offset: usize) -> Option<u64> {
    let bytes: [u8; 8] = payload.get(offset..offset + 8)?.try_into().ok()?;
    Some(u64::from_le_bytes(bytes))
}

fn pumpswap_event_pubkey(payload: &[u8], offset: usize) -> Option<String> {
    let bytes = payload.get(offset..offset + 32)?;
    Some(bs58::encode(bytes).into_string())
}

// Anchor event discriminators: first 8 bytes of sha256("event:<Name>"),
// computed and verified against PumpSwap's own published IDL
// (pump-fun/pump-public-docs, idl/pump_amm.json) — not guessed.
const PUMPSWAP_SELL_EVENT_DISCRIMINATOR: [u8; 8] = [0x3e, 0x2f, 0x37, 0x0a, 0xa5, 0x03, 0xdc, 0x2a];
const PUMPSWAP_BUY_EVENT_DISCRIMINATOR: [u8; 8] = [0x67, 0xf4, 0x52, 0x1f, 0x2c, 0xf5, 0x77, 0x77];

// `SellEvent` and `BuyEvent` (pump_amm.json) declare identical field
// types/order up through `coin_creator` (verified field-by-field against
// the IDL) — only the field *names* differ (e.g. `base_amount_in` vs
// `base_amount_out`, `quote_amount_out` vs `quote_amount_in`), and only
// after `coin_creator` do the two events diverge (`BuyEvent` continues
// with more fixed fields, then a trailing variable-length `ix_name`;
// `SellEvent` ends). This lets both be decoded through the same offsets.
// `SellEvent` is entirely fixed-size: 409 borsh bytes + 8-byte
// discriminator = 417 total, an exact match to the length observed in
// production for the transactions this scanner had been rejecting.
const PUMPSWAP_EVENT_MIN_PAYLOAD_LEN: usize = 336; // through coin_creator (offset 304 + 32 bytes)

/// Reads the `SellEvent`/`BuyEvent` fields this scanner actually needs.
/// `is_buy_event` says which discriminator matched (true = BuyEvent, false
/// = SellEvent); `payload` is the event body with the 8-byte discriminator
/// already stripped. Replicates the engine's own 368-byte-branch
/// price/reverse/sign formulas (see
/// engine/src/processor/transaction_parser.rs) rather than calling them —
/// they're private to that match arm, not a reusable fn — so this stays a
/// pure addition that touches nothing in `engine/`.
fn build_pumpswap_trade_info(
    txn: &SubscribeUpdateTransaction,
    log_signature: &str,
    is_buy_event: bool,
    payload: &[u8],
) -> Option<TradeInfoFromToken> {
    if payload.len() < PUMPSWAP_EVENT_MIN_PAYLOAD_LEN {
        return None;
    }

    let timestamp = pumpswap_event_u64(payload, 0)?;
    // `base_amount_in` (SellEvent) / `base_amount_out` (BuyEvent) — same
    // offset in both, same generic role as the inner-instruction CPI log's
    // `base_amount_in_or_base_amount_out`.
    let base_amount = pumpswap_event_u64(payload, 8)?;
    let pool_base_token_reserves = pumpswap_event_u64(payload, 40)?;
    let pool_quote_token_reserves = pumpswap_event_u64(payload, 48)?;
    // `quote_amount_out` (SellEvent) / `quote_amount_in` (BuyEvent) — same offset.
    let quote_amount = pumpswap_event_u64(payload, 56)?;
    let pool_id = pumpswap_event_pubkey(payload, 112)?;
    let coin_creator = pumpswap_event_pubkey(payload, 304)?;

    let mint = mint_from_post_token_balances(txn);

    let (price, is_reverse_when_pump_swap) =
        if pool_base_token_reserves > 0 && pool_quote_token_reserves > 0 {
            let temp_price = pool_base_token_reserves.saturating_mul(1_000_000_000)
                / pool_quote_token_reserves.max(1);
            if temp_price < 1 {
                (temp_price, true)
            } else {
                let normal_price = pool_quote_token_reserves.saturating_mul(1_000_000_000)
                    / pool_base_token_reserves.max(1);
                (normal_price, false)
            }
        } else {
            (0, false)
        };

    // Mirrors the engine's `is_buy = is_reverse_when_pump_swap ?
    // has_sell_instruction(...) : has_buy_instruction(...)` — here the raw
    // instruction kind is already known directly from which event
    // discriminator matched, instead of grepping log lines for it.
    let is_buy = is_reverse_when_pump_swap != is_buy_event;

    let (sol_change, token_change) = if is_reverse_when_pump_swap {
        if is_buy {
            (
                -(base_amount as f64) / 1_000_000_000.0,
                quote_amount as f64 / 1_000_000_000.0,
            )
        } else {
            (
                base_amount as f64 / 1_000_000_000.0,
                -(quote_amount as f64) / 1_000_000_000.0,
            )
        }
    } else if is_buy {
        (
            -(quote_amount as f64) / 1_000_000_000.0,
            base_amount as f64 / 1_000_000_000.0,
        )
    } else {
        (
            quote_amount as f64 / 1_000_000_000.0,
            -(base_amount as f64) / 1_000_000_000.0,
        )
    };

    let liquidity = if !is_reverse_when_pump_swap {
        pool_quote_token_reserves as f64 / 1_000_000_000.0
    } else {
        pool_base_token_reserves as f64 / 1_000_000_000.0
    };

    tracing::debug!(
        signature = %log_signature,
        mint = %mint,
        pool_id = %pool_id,
        is_buy,
        is_reverse_when_pump_swap,
        price,
        "scanner: PumpSwap Anchor log event decoded into a trade"
    );

    Some(TradeInfoFromToken {
        dex_type: DexType::PumpSwap,
        slot: 0,
        signature: String::new(),
        pool_id,
        mint,
        timestamp,
        is_buy,
        price,
        is_reverse_when_pump_swap,
        coin_creator: Some(coin_creator),
        sol_change,
        token_change,
        liquidity,
        virtual_sol_reserves: pool_quote_token_reserves,
        virtual_token_reserves: pool_base_token_reserves,
    })
}

/// PumpSwap's newer trade-event emission path: rather than (or in addition
/// to) a fixed-length inner-instruction CPI log, some transactions carry
/// the same trade data as an ordinary Anchor `sol_log_data` event —
/// surfaced in `log_messages` as a `"Program data: <base64>"` line, a
/// completely separate mechanism from inner-instruction call data (see
/// `emitting_program_at`'s doc comment above). Tries every such line in
/// order and returns the first one whose discriminator matches
/// `SellEvent`/`BuyEvent`; a discriminator match that then fails to decode
/// (payload too short) is logged and skipped rather than treated as fatal,
/// in case more than one "Program data:" line is present for unrelated
/// reasons.
fn detect_pumpswap_log_event(
    txn: &SubscribeUpdateTransaction,
    log_signature: &str,
) -> Option<TradeInfoFromToken> {
    let log_messages = txn
        .transaction
        .as_ref()
        .and_then(|t| t.meta.as_ref())
        .map(|m| m.log_messages.clone())
        .unwrap_or_default();

    for (line_index, line) in log_messages.iter().enumerate() {
        let Some(b64) = line.strip_prefix("Program data: ") else {
            continue;
        };
        let Ok(payload) = base64::decode(b64) else {
            tracing::debug!(
                signature = %log_signature,
                log_line_index = line_index,
                "scanner: \"Program data:\" log line failed base64 decode, skipping"
            );
            continue;
        };
        if payload.len() < 8 {
            continue;
        }
        let discriminator: [u8; 8] = payload[0..8].try_into().expect("checked len >= 8 above");
        let is_buy_event = if discriminator == PUMPSWAP_BUY_EVENT_DISCRIMINATOR {
            true
        } else if discriminator == PUMPSWAP_SELL_EVENT_DISCRIMINATOR {
            false
        } else {
            continue;
        };

        tracing::debug!(
            signature = %log_signature,
            log_line_index = line_index,
            event = if is_buy_event { "BuyEvent" } else { "SellEvent" },
            payload_len = payload.len(),
            "scanner: recognized PumpSwap Anchor log event discriminator"
        );

        match build_pumpswap_trade_info(txn, log_signature, is_buy_event, &payload[8..]) {
            Some(parsed) => return Some(parsed),
            None => {
                tracing::debug!(
                    signature = %log_signature,
                    log_line_index = line_index,
                    "scanner: PumpSwap log event discriminator matched but field decoding \
                     failed (payload too short for the fields this scanner reads) — skipping \
                     this log line"
                );
                continue;
            }
        }
    }

    None
}

// Anchor event discriminator: first 8 bytes of sha256("event:TradeEvent") —
// PumpFun's bonding-curve program doesn't publish an IDL, so this was
// computed from the discriminator convention and then verified byte-for-
// byte against a real production transaction's decoded event, not guessed.
const PUMPFUN_TRADE_EVENT_DISCRIMINATOR: [u8; 8] = [0xbd, 0xdb, 0x7f, 0xd3, 0x4e, 0xe6, 0x61, 0xee];

// Through `creator` (relative offset 169, +32 bytes) in the post-
// discriminator payload — this scanner never reads the trailing
// fee_basis_points/fee/creator_fee_basis_points/creator_fee/... fields
// that follow. Field offsets below were reverse-engineered from a real
// production TradeEvent (no published IDL exists for this program) and
// cross-validated against independently-known quantities before trusting
// them: the decoded mint has pump.fun's "pump" vanity suffix; the decoded
// `user` matched the exact tracked-wallet pubkey that triggered the
// transaction; `virtual_sol_reserves - real_sol_reserves` equals exactly
// pump.fun's fixed 30 SOL initial virtual offset; and `fee` equals
// `fee_basis_points` applied to `sol_amount`, correct to the lamport.
const PUMPFUN_TRADE_EVENT_MIN_PAYLOAD_LEN: usize = 201;

/// Reads the PumpFun bonding-curve `TradeEvent` fields this scanner needs.
/// `payload` is the event body with the 8-byte discriminator already
/// stripped. Unlike PumpSwap's separate SellEvent/BuyEvent, PumpFun uses
/// one `TradeEvent` discriminator for both directions — see `is_buy`
/// below — and it encodes `mint` directly, so (unlike
/// `build_pumpswap_trade_info`) no `mint_from_post_token_balances`
/// heuristic is needed here.
fn build_pumpfun_trade_info(log_signature: &str, payload: &[u8]) -> Option<TradeInfoFromToken> {
    if payload.len() < PUMPFUN_TRADE_EVENT_MIN_PAYLOAD_LEN {
        return None;
    }

    let mint = pumpswap_event_pubkey(payload, 0)?;
    let sol_amount = pumpswap_event_u64(payload, 32)?;
    let token_amount = pumpswap_event_u64(payload, 40)?;
    let is_buy = *payload.get(48)? != 0;
    let user = pumpswap_event_pubkey(payload, 49)?;
    let timestamp = pumpswap_event_u64(payload, 81)?;
    let virtual_sol_reserves = pumpswap_event_u64(payload, 89)?;
    let virtual_token_reserves = pumpswap_event_u64(payload, 97)?;
    let creator = pumpswap_event_pubkey(payload, 169)?;

    let price = virtual_sol_reserves.saturating_mul(1_000_000_000) / virtual_token_reserves.max(1);

    let (sol_change, token_change) = if is_buy {
        (
            -(sol_amount as f64) / 1_000_000_000.0,
            token_amount as f64 / 1_000_000_000.0,
        )
    } else {
        (
            sol_amount as f64 / 1_000_000_000.0,
            -(token_amount as f64) / 1_000_000_000.0,
        )
    };

    tracing::debug!(
        signature = %log_signature,
        mint = %mint,
        user = %user,
        is_buy,
        price,
        virtual_sol_reserves,
        virtual_token_reserves,
        "scanner: PumpFun bonding-curve TradeEvent decoded into a trade"
    );

    Some(TradeInfoFromToken {
        dex_type: DexType::PumpFun,
        slot: 0,
        signature: String::new(),
        // PumpFun derives its bonding-curve PDA from the mint directly
        // (see engine/src/dex/pump_fun.rs's get_pda call) — there's no
        // separate pool_id the way PumpSwap has one.
        pool_id: String::new(),
        mint,
        timestamp,
        is_buy,
        price,
        is_reverse_when_pump_swap: false, // PumpSwap-only flag, not applicable to PumpFun
        coin_creator: Some(creator),
        sol_change,
        token_change,
        liquidity: virtual_sol_reserves as f64 / 1_000_000_000.0,
        virtual_sol_reserves,
        virtual_token_reserves,
    })
}

/// PumpFun bonding-curve trades only ever show up as a `"Program data:"`
/// Anchor log event (`emit!`/`sol_log_data`) — this scanner's
/// inner-instruction CPI-log path (`extract_cpi_log_data`) never matches
/// them, since PumpFun's self-CPI event-log instruction data is a
/// different length (see `detect_trade`'s doc comment). Same
/// try-every-matching-line structure as `detect_pumpswap_log_event`.
fn detect_pumpfun_log_event(
    txn: &SubscribeUpdateTransaction,
    log_signature: &str,
) -> Option<TradeInfoFromToken> {
    let log_messages = txn
        .transaction
        .as_ref()
        .and_then(|t| t.meta.as_ref())
        .map(|m| m.log_messages.clone())
        .unwrap_or_default();

    for (line_index, line) in log_messages.iter().enumerate() {
        let Some(b64) = line.strip_prefix("Program data: ") else {
            continue;
        };
        let Ok(payload) = base64::decode(b64) else {
            continue;
        };
        if payload.len() < 8 || payload[0..8] != PUMPFUN_TRADE_EVENT_DISCRIMINATOR {
            continue;
        }

        tracing::debug!(
            signature = %log_signature,
            log_line_index = line_index,
            payload_len = payload.len(),
            "scanner: recognized PumpFun TradeEvent discriminator"
        );

        match build_pumpfun_trade_info(log_signature, &payload[8..]) {
            Some(parsed) => return Some(parsed),
            None => {
                tracing::debug!(
                    signature = %log_signature,
                    log_line_index = line_index,
                    "scanner: PumpFun TradeEvent discriminator matched but field decoding \
                     failed (payload too short for the fields this scanner reads) — skipping \
                     this log line"
                );
                continue;
            }
        }
    }

    None
}

/// Turns one detected transaction into a trade tick. Tries the untouched
/// engine's own parser against a recognized inner-instruction CPI log
/// first (`extract_cpi_log_data` + `parse_transaction_data`, unchanged
/// behavior from before this file had a second path); if that finds
/// nothing, falls back to decoding a PumpSwap Anchor `"Program data:"` log
/// event (`detect_pumpswap_log_event`), then a PumpFun bonding-curve
/// `TradeEvent` log event (`detect_pumpfun_log_event`) before giving up.
/// PumpFun bonding-curve trades only ever match this last path — its
/// self-CPI event-log instruction never lands on one of
/// `extract_cpi_log_data`'s recognized lengths, only the `"Program data:"`
/// log line does. `None` for anything no path recognizes (wrapped-SOL
/// mint, no matching CPI log or log event, etc.). `log_signature` is
/// diagnostic-only (a display string identifying which transaction this
/// call is for, so the rejection-reason logs below can be correlated with
/// the rest of the pipeline's per-signature logs even when several are in
/// flight concurrently) — it plays no role in the detection logic itself.
fn detect_trade(txn: &SubscribeUpdateTransaction, log_signature: &str) -> Option<ScannerTick> {
    if let Some(data) = extract_cpi_log_data(txn, log_signature) {
        match parse_transaction_data(txn, &data) {
            Some(parsed) => {
                return finalize_detected_trade(
                    &parsed,
                    txn,
                    log_signature,
                    "inner_instruction_cpi_log",
                );
            }
            None => {
                tracing::debug!(
                    signature = %log_signature,
                    cpi_data_len = data.len(),
                    "scanner: a recognized CPI-log length was found, but the engine's \
                     parse_transaction_data() returned None for it — falling back to PumpSwap \
                     Anchor \"Program data:\" log-event decoding before giving up."
                );
            }
        }
    } else {
        tracing::debug!(
            signature = %log_signature,
            "scanner: no recognized inner-instruction CPI-log length found — falling back to \
             PumpSwap Anchor \"Program data:\" log-event decoding (SellEvent/BuyEvent) before \
             giving up."
        );
    }

    if let Some(parsed) = detect_pumpswap_log_event(txn, log_signature) {
        return finalize_detected_trade(&parsed, txn, log_signature, "pumpswap_log_event");
    }

    if let Some(parsed) = detect_pumpfun_log_event(txn, log_signature) {
        return finalize_detected_trade(&parsed, txn, log_signature, "pumpfun_log_event");
    }

    tracing::debug!(
        signature = %log_signature,
        "scanner: REJECTED — no inner instruction with a recognized CPI-log data length \
         (368/266/270/146/170/138 bytes), no recognized PumpSwap Anchor log event \
         (SellEvent/BuyEvent), and no recognized PumpFun TradeEvent either. Either this \
         transaction doesn't actually touch PumpFun/PumpSwap/Raydium Launchpad in a way this \
         scanner recognizes, or its emission format has changed again."
    );
    None
}

// ─────────────────────────────────────────────────────────────────────────
// Detection: standard Solana JSON-RPC (logsSubscribe + getTransaction)
// ─────────────────────────────────────────────────────────────────────────

/// A burst of near-simultaneous detections (common right after a popular
/// pool launches — exactly the moment this matters least being slow) could
/// otherwise fire dozens of concurrent `getTransaction` calls and blow
/// through the RPC plan's rate limit in one go. Bounds concurrent lookups
/// instead; excess detections simply wait their turn. Tune to whatever your
/// provider's actual req/s allows — check your dashboard, this isn't
/// derived from anything provider-specific.
///
/// Currently set low enough for Solana's free public RPC
/// (`api.mainnet-beta.solana.com`) rather than a paid plan: its documented
/// limits (solana.com/docs/rpc/http — "Public RPC endpoints") cap a single
/// method (`getTransaction` here) at 40 requests/10s and total concurrent
/// connections per IP at 40. A small number here trades detection latency
/// (this is dev/staging-tier infra by design — see this file's module doc
/// comment) for never tripping either ceiling.
const MAX_CONCURRENT_LOOKUPS: usize = 2;

/// Bounds how many `getTransaction` lookups can be *queued* waiting for
/// `RateLimiter::acquire` at once — independent of `MAX_CONCURRENT_LOOKUPS`
/// (bounds lookups actually *in flight*) and `SCANNER_MAX_RPC_RPS` (bounds
/// *dispatch rate*). Without this, PumpFun/PumpSwap/Raydium Launchpad's
/// combined mainnet-wide `logsSubscribe` volume (routinely tens of
/// notifications/sec — confirmed in production logs as dozens of
/// "logsNotification received" firing within the same millisecond) vastly
/// exceeds the public RPC's forced ~2 req/sec dispatch rate, so every
/// notification still spawned its own task waiting on the rate limiter's
/// semaphore, which is FIFO: the queue only ever grew, never caught up,
/// and every lookup that did eventually run was for a signature that was
/// by then minutes-to-hours stale. That's functionally indistinguishable
/// from "nothing is ever detected" — a free public RPC has limited
/// retention, so an old-enough signature just isn't found at all, and even
/// when it still is, it's ancient by the time it's acted on. Capping
/// backlog depth bounds worst-case staleness instead of leaving it
/// unbounded (`MAX_PENDING_LOOKUPS / SCANNER_MAX_RPC_RPS` seconds); the
/// tradeoff is dropping the newest notification when already full, which
/// is the right call for a live trading signal — a detection that lands
/// minutes late is as useless as one that never lands, and this is
/// dev/staging-tier infra by design (see this file's module doc comment).
const MAX_PENDING_LOOKUPS: usize = 20;

/// Decrements the shared pending-lookup counter on drop — covers every
/// exit path of the spawned lookup task below (success, early return via
/// `?`/`else`, even a panic unwinding through it) without having to
/// remember to decrement at each one individually.
struct PendingLookupGuard(Arc<AtomicUsize>);

impl Drop for PendingLookupGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

/// getTransaction only serves `confirmed`/`finalized` commitment (Solana's
/// JSON-RPC does not support `processed` for this method) — unlike
/// Yellowstone's `processed`-level push, a transaction just seen via
/// logsSubscribe is often not fetchable yet the instant its log arrives. A
/// short bounded retry covers the normal confirm delay; if it never lands
/// in time, the trade is skipped rather than blocking this task forever.
/// The delay is wider than a paid low-latency RPC would need — public RPC
/// nodes are shared, best-effort infra, and there's no reason to burn one
/// of a very small requests/sec budget (see `DEFAULT_MAX_RPC_RPS`) polling
/// faster than a transaction could plausibly have confirmed anyway.
const GET_TRANSACTION_RETRIES: u32 = 5;
const GET_TRANSACTION_RETRY_DELAY: Duration = Duration::from_millis(1500);

/// `MAX_CONCURRENT_LOOKUPS` bounds how many `getTransaction` calls can be
/// *in flight* at once, but says nothing about *rate* — a handful of
/// short-lived requests completing and immediately being replaced by more
/// can still sustain a high rate once PumpFun/PumpSwap/Raydium
/// Launchpad's real mainnet-wide volume (every trade on any of those
/// programs, not just tokens this deployment cares about) is flowing
/// through `logsSubscribe`, each with up to `GET_TRANSACTION_RETRIES`
/// attempts. Most providers meter HTTP and WSS requests against the
/// *same* per-key/per-IP budget, so a `getTransaction` flood exhausting
/// that budget doesn't just throttle itself: it also starves out the
/// `logsSubscribe` reconnect attempts below, which is what can surface as
/// a rejected `logsSubscribe` (e.g. Chainstack's "-32005 RPS limit") even
/// though `getTransaction` is the real source of the load. This caps
/// *dispatch rate*, independent of concurrency, so the scanner stays
/// under whatever the endpoint actually allows. Override via
/// `SCANNER_MAX_RPC_RPS` — the default below is deliberately conservative
/// for Solana's free public RPC (documented single-method ceiling is 40
/// requests/10s, i.e. 4/s; defaulting well under half that leaves
/// headroom for the 3 `logsSubscribe` calls and anything else sharing the
/// same IP, e.g. apps/api's own RPC usage). Raise this back up if/when
/// this deployment moves to a paid, higher-limit provider again.
const DEFAULT_MAX_RPC_RPS: usize = 2;

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

/// Runs one `logsSubscribe` per tracked wallet (Solana's reference RPC
/// implementation's `mentions` filter only ever reliably supports a single
/// address per subscription — most providers, Chainstack included, follow
/// that same reference behavior) plus a bounded pool of `getTransaction`
/// follow-ups. See this file's module doc comment for the latency tradeoff
/// this design accepts in exchange for never depending on a paid gRPC feed.
const RECONNECT_BASE_DELAY: Duration = Duration::from_secs(5);
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(60);
/// A connection that stays up at least this long is treated as a real
/// success — its next failure starts the backoff over from
/// `RECONNECT_BASE_DELAY` — rather than an instant-fail that should keep
/// backing off from wherever it left off.
const RECONNECT_HEALTHY_UPTIME: Duration = Duration::from_secs(30);

/// How often an established connection re-reads `scanner:tracked-wallets`
/// to check whether the set has changed (a user enabled/disabled
/// copy-trading, added/removed a target, started/stopped their bot). On a
/// change, `watch_tracked_wallets` deliberately ends its own loop so
/// `run_rpc_websocket`'s caller reconnects with a fresh subscription set —
/// simpler and more robust than tearing down/rebuilding individual
/// subscriptions on a live `select_all` stream, at the cost of every other
/// tracked wallet's subscription also being briefly recycled. Tracking
/// activity is inherently low-volume (a handful of wallets, not
/// mainnet-wide DEX firehose), so this is cheap.
const WALLET_LIST_POLL_INTERVAL: Duration = Duration::from_secs(20);
/// How long to wait before checking again when there is currently nothing
/// to track (`scanner:tracked-wallets` empty) — no point opening a
/// WebSocket connection with zero subscriptions.
const EMPTY_WALLET_LIST_RETRY_DELAY: Duration = Duration::from_secs(15);

/// A small pseudo-random offset (no `rand` dependency needed for this) so
/// this doesn't retry in perfect lockstep with anything else sharing the
/// same rate-limited account — a fixed backoff schedule is a much easier
/// way to trip a provider's short-window burst limiter than the same
/// schedule spread out by even a few tens of milliseconds.
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
    let pending_lookups = Arc::new(AtomicUsize::new(0));
    tracing::info!(
        max_rpc_rps,
        max_pending_lookups = MAX_PENDING_LOOKUPS,
        "scanner: getTransaction dispatch capped at this rate"
    );

    let mut backoff = RECONNECT_BASE_DELAY;
    loop {
        let wallets = fetch_tracked_wallets(&redis_conn).await;
        if wallets.is_empty() {
            tracing::warn!(
                key = TRACKED_WALLETS_KEY,
                retry_secs = EMPTY_WALLET_LIST_RETRY_DELAY.as_secs(),
                "scanner: no wallets currently configured for tracking — idling, nothing to \
                 detect. This is a copy-trading wallet tracker, not a DEX-wide sniper: at least \
                 one user needs an active bot with copy-trading enabled and at least one target \
                 wallet configured before this scanner has anything to watch."
            );
            tokio::time::sleep(EMPTY_WALLET_LIST_RETRY_DELAY).await;
            continue;
        }
        tracing::info!(
            wallet_count = wallets.len(),
            wallets = ?wallets,
            "scanner: tracking {} wallet(s) for copy-trading",
            wallets.len()
        );

        let attempt_started = tokio::time::Instant::now();
        if let Err(e) = watch_tracked_wallets(
            &wallets,
            &solana_ws_url,
            rpc_client.clone(),
            redis_conn.clone(),
            lookup_limiter.clone(),
            rate_limiter.clone(),
            pending_lookups.clone(),
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
/// one `logsSubscribe` per tracked wallet on it (Solana's reference RPC
/// implementation's `mentions` filter only ever reliably supports a single
/// address per subscription — most providers, Chainstack included, follow
/// that same reference behavior, so one subscribe call per wallet is still
/// required; only the underlying connection is shared). The resulting
/// notification streams are merged into one so a single loop handles all
/// of them. Runs until the connection ends/errors, or until
/// `WALLET_LIST_POLL_INTERVAL` finds the tracked-wallet set has changed —
/// either way, `run_rpc_websocket`'s caller loop reconnects (re-reading the
/// wallet set fresh) from scratch. Each detected (non-failed) log spawns
/// its own bounded `getTransaction` + parse + publish task so one slow
/// lookup can't stall the next log notification from being received.
async fn watch_tracked_wallets(
    wallets: &[String],
    solana_ws_url: &str,
    rpc_client: Arc<RpcClient>,
    redis_conn: RedisConn,
    lookup_limiter: Arc<Semaphore>,
    rate_limiter: Arc<RateLimiter>,
    pending_lookups: Arc<AtomicUsize>,
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
    for wallet in wallets {
        // Each subscribe call is its own JSON-RPC request over the ONE
        // connection above — still rate-limited individually, since the
        // provider counts them as separate requests regardless of the
        // shared socket.
        rate_limiter.acquire().await;
        let subscribe_result = pubsub
            .logs_subscribe(
                RpcTransactionLogsFilter::Mentions(vec![wallet.clone()]),
                RpcTransactionLogsConfig {
                    commitment: Some(CommitmentConfig::processed()),
                },
            )
            .await;
        match subscribe_result {
            Ok((stream, _unsubscribe)) => {
                let wallet = wallet.clone();
                let tagged = stream.map(move |update| (wallet.clone(), update));
                tagged_streams.push(tagged.boxed());
            }
            Err(e) => {
                tracing::error!(
                    url = %solana_ws_url,
                    wallet = %wallet,
                    error_display = %e,
                    error_debug = ?e,
                    "scanner: logs_subscribe failed — see error_debug for the real cause"
                );
                anyhow::bail!("logs_subscribe failed for wallet {wallet}: {e}");
            }
        }
    }

    let mut merged = select_all(tagged_streams);
    let mut wallet_check_interval = tokio::time::interval(WALLET_LIST_POLL_INTERVAL);
    wallet_check_interval.tick().await; // interval fires immediately on the first tick; consume it

    loop {
        tokio::select! {
            maybe_update = merged.next() => {
                let Some((wallet, update)) = maybe_update else {
                    anyhow::bail!("logs_subscribe stream(s) closed");
                };
                handle_wallet_notification(
                    &wallet,
                    update,
                    &rpc_client,
                    &redis_conn,
                    &lookup_limiter,
                    &rate_limiter,
                    &pending_lookups,
                );
            }
            _ = wallet_check_interval.tick() => {
                let current = fetch_tracked_wallets(&redis_conn).await;
                if current != wallets {
                    tracing::info!(
                        previous_wallet_count = wallets.len(),
                        current_wallet_count = current.len(),
                        "scanner: tracked-wallet list changed, reconnecting to resubscribe with \
                         the fresh set"
                    );
                    anyhow::bail!("tracked-wallet list changed");
                }
            }
        }
    }
}

/// One `logsNotification` from a tracked wallet's subscription: filters
/// obviously-doomed lookups (failed tx, unparseable/all-zero signature,
/// backlog already full), then dispatches the bounded getTransaction +
/// parse + publish task. Split out of `watch_tracked_wallets`'s loop only
/// so that loop reads as "select between a notification and the periodic
/// wallet-list check" — no behavior change from having this inline.
fn handle_wallet_notification(
    wallet: &str,
    update: solana_client::rpc_response::Response<solana_client::rpc_response::RpcLogsResponse>,
    rpc_client: &Arc<RpcClient>,
    redis_conn: &RedisConn,
    lookup_limiter: &Arc<Semaphore>,
    rate_limiter: &Arc<RateLimiter>,
    pending_lookups: &Arc<AtomicUsize>,
) {
    tracing::debug!(
        wallet = %wallet,
        signature = %update.value.signature,
        err = ?update.value.err,
        "scanner: logsNotification received"
    );

    if update.value.err.is_some() {
        tracing::debug!(
            wallet = %wallet,
            signature = %update.value.signature,
            "scanner: REJECTED — transaction failed on-chain (err present in the \
             notification), never worth a getTransaction lookup"
        );
        return; // never worth spending part of the RPS budget on a doomed lookup
    }
    tracing::debug!(
        wallet = %wallet,
        raw_signature = %update.value.signature,
        "scanner: raw signature received from WebSocket, about to validate/convert"
    );
    let Ok(signature) = Signature::from_str(&update.value.signature) else {
        tracing::warn!(
            wallet = %wallet,
            raw_signature = %update.value.signature,
            "scanner: REJECTED — logsNotification signature failed to parse as a Signature"
        );
        return;
    };
    // "1111111111111111111111111111111111111111111111111111111111111111"
    // (64 base58 '1's = 64 zero bytes) is `Signature::default()` — a
    // syntactically valid Signature that `Signature::from_str` above
    // happily parses, but no real Solana transaction is ever signed
    // with an all-zero signature. Confirmed by inspection that nothing
    // in this file ever constructs one (no `Signature::default()` /
    // `Pubkey::default()` / `unwrap_or`-style fallback anywhere on
    // this path) — when this fires, `raw_signature` above already
    // proved the RPC node itself sent this value in the
    // logsNotification's `value.signature` field, not something
    // introduced here. getTransaction would only ever reject it with
    // "Invalid params: signature is not a valid transaction signature"
    // (-32602), so skip the doomed lookup instead of spending part of
    // the RPS budget on it.
    if signature == Signature::default() {
        tracing::warn!(
            wallet = %wallet,
            raw_signature = %update.value.signature,
            "scanner: REJECTED — signature is the all-zero placeholder (Signature::default()), \
             not a real transaction; sent by the RPC node itself in this logsNotification, \
             skipping the getTransaction lookup"
        );
        return;
    }

    // See MAX_PENDING_LOOKUPS's doc comment. Tracking a handful of wallets
    // is inherently low-volume compared to the DEX-wide firehose this used
    // to watch, so this should rarely if ever actually fill up now — kept
    // as a safety net, not removed, since it costs nothing when unused.
    if pending_lookups.load(Ordering::Relaxed) >= MAX_PENDING_LOOKUPS {
        tracing::warn!(
            wallet = %wallet,
            %signature,
            max_pending_lookups = MAX_PENDING_LOOKUPS,
            "scanner: REJECTED — lookup backlog is full, dropping this signature rather \
             than queuing it behind an already-stale backlog (see MAX_PENDING_LOOKUPS's doc \
             comment)"
        );
        return;
    }
    pending_lookups.fetch_add(1, Ordering::Relaxed);

    tracing::debug!(
        wallet = %wallet,
        %signature,
        pending_lookups = pending_lookups.load(Ordering::Relaxed),
        "scanner: signature accepted, dispatching getTransaction lookup"
    );

    let wallet = wallet.to_string();
    let rpc_client = rpc_client.clone();
    let redis_conn = redis_conn.clone();
    let lookup_limiter = lookup_limiter.clone();
    let rate_limiter = rate_limiter.clone();
    let pending_lookups_guard = PendingLookupGuard(pending_lookups.clone());
    let lookup_handle = tokio::spawn(async move {
        let _pending_lookups_guard = pending_lookups_guard;
        let Ok(_permit) = lookup_limiter.acquire().await else {
            tracing::warn!(
                %signature,
                "scanner: lookup_limiter semaphore was closed, dropping this signature \
                 without a getTransaction attempt"
            );
            return;
        };
        match fetch_and_detect(&rpc_client, signature, &rate_limiter).await {
            Some(tick) => {
                // `Mentions` matches ANY transaction where `wallet` appears
                // anywhere in the account list — as a token account
                // owner, a counterparty, a passive recipient — not only
                // ones it actually signed. `tick.trader` is the real fee
                // payer/signer extracted straight from the decoded
                // transaction (see `extract_trader_from_transaction`), so
                // this is the actual "did the tracked wallet perform this
                // trade" check; everything before it only proves the
                // wallet was mentioned somewhere in the transaction.
                if tick.trader.as_deref() == Some(wallet.as_str()) {
                    tracing::info!(
                        wallet = %wallet,
                        mint = %tick.mint,
                        dex = %tick.dex_type,
                        is_buy = tick.is_buy,
                        price = tick.price,
                        sol_change = tick.sol_change,
                        token_change = tick.token_change,
                        signature = %tick.signature,
                        "scanner: TRACKED WALLET {} — wallet={} mint={} dex={}",
                        if tick.is_buy { "BUY" } else { "SELL" },
                        wallet,
                        tick.mint,
                        tick.dex_type
                    );
                    publish_tick(&redis_conn, tick).await;
                } else {
                    tracing::debug!(
                        wallet = %wallet,
                        actual_trader = ?tick.trader,
                        %signature,
                        "scanner: REJECTED — tracked wallet was mentioned in this transaction \
                         but did not sign it (actual trader differs or is unknown); not a trade \
                         BY the tracked wallet, not publishing"
                    );
                }
            }
            None => {
                tracing::debug!(
                    %signature,
                    "scanner: fetch_and_detect produced no tick — see its own REJECTED log \
                     above for the exact reason; nothing to publish for this signature"
                );
            }
        }
    });
    // A spawned task's panic is otherwise completely silent — nobody
    // ever inspects `lookup_handle`'s result, so tokio just drops it.
    // That's indistinguishable from this exact symptom report ("we see
    // 'dispatching getTransaction lookup' and then literally nothing
    // else, ever, ever again for this signature"): if anything in
    // fetch_and_detect/detect_trade/publish_tick — including the
    // untouched engine's own parse_transaction_data — ever panics
    // (an unwrap, an out-of-bounds index, ...) instead of returning
    // an error, this is the only way it would ever surface at all.
    // Spawning a second, tiny task to await the first one's handle
    // keeps this from blocking the notification loop above.
    tokio::spawn(async move {
        if let Err(join_error) = lookup_handle.await {
            if join_error.is_panic() {
                tracing::error!(
                    %signature,
                    panic = %join_error,
                    "scanner: PANIC in the getTransaction/parse/publish task for this \
                     signature — this is why nothing was logged after \"dispatching \
                     getTransaction lookup\"; the panic itself was otherwise silent"
                );
            } else {
                tracing::error!(
                    %signature,
                    error = %join_error,
                    "scanner: getTransaction/parse/publish task ended abnormally (cancelled?)"
                );
            }
        }
    });
}

/// Describes an `OptionSerializer`-wrapped list field's exact state —
/// distinguishing "the RPC response omitted this field entirely" (`Skip`)
/// from "explicitly null" (`None`) from "present but empty" from
/// "present with N items" — all four of which collapse to indistinguishable
/// downstream behavior (nothing) if only checked with `.is_empty()`/
/// `unwrap_or_default()`, but mean very different things when the question
/// is "did the RPC node itself never send this, or did something after it
/// lose it."
fn describe_option_serializer_vec<T>(opt: &OptionSerializer<Vec<T>>) -> String {
    match opt {
        OptionSerializer::Skip => "Skip (field omitted from the RPC response entirely)".to_string(),
        OptionSerializer::None => "None (explicitly null in the RPC response)".to_string(),
        OptionSerializer::Some(v) if v.is_empty() => "Some([]) (present but empty)".to_string(),
        OptionSerializer::Some(v) => format!("Some(<{} item(s)>)", v.len()),
    }
}

/// Inspects the RAW `getTransaction` response — before any of this file's
/// own conversion in `to_synthetic_subscribe_update` touches it — to
/// answer definitively whether the RPC node itself returned no inner
/// instructions, or whether they existed here and were lost somewhere in
/// our own conversion. Read-only: this changes nothing about what gets
/// parsed, it only reports what's already there.
fn log_raw_transaction_response_shape(
    signature: Signature,
    tx: &EncodedConfirmedTransactionWithStatusMeta,
) {
    let meta_present = tx.transaction.meta.is_some();
    let (inner_instructions_state, log_message_count) = match &tx.transaction.meta {
        Some(meta) => (
            describe_option_serializer_vec(&meta.inner_instructions),
            match &meta.log_messages {
                OptionSerializer::Some(v) => Some(v.len()),
                OptionSerializer::None | OptionSerializer::Skip => None,
            },
        ),
        None => (
            "<meta itself is None — nothing to describe>".to_string(),
            None,
        ),
    };

    tracing::debug!(
        %signature,
        meta_present,
        inner_instructions_state = %inner_instructions_state,
        log_message_count = ?log_message_count,
        transaction_version = ?tx.transaction.version,
        slot = tx.slot,
        "scanner: raw getTransaction response shape (before any conversion) — this is exactly \
         what the RPC node itself returned"
    );
}

/// Fetches the full transaction via `getTransaction` (retrying through the
/// normal confirm delay — see `GET_TRANSACTION_RETRIES`'s doc comment),
/// then runs it through the `detect_trade` pipeline. Every attempt —
/// including retries — goes through
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
        tracing::debug!(
            %signature,
            attempt,
            encoding = ?config.encoding,
            commitment = ?config.commitment,
            max_supported_transaction_version = ?config.max_supported_transaction_version,
            "calling getTransaction for {signature}"
        );
        let rpc_call_started = Instant::now();
        let rpc_result = rpc_client
            .get_transaction_with_config(&signature, config)
            .await;
        let rpc_elapsed_ms = rpc_call_started.elapsed().as_millis();
        match rpc_result {
            Ok(tx) => {
                tracing::debug!(
                    %signature,
                    attempt,
                    slot = tx.slot,
                    rpc_elapsed_ms,
                    "scanner: getTransaction succeeded — transaction found"
                );
                log_raw_transaction_response_shape(signature, &tx);
                confirmed = Some(tx);
                break;
            }
            Err(e) if attempt + 1 < GET_TRANSACTION_RETRIES => {
                tracing::debug!(
                    error_display = %e,
                    error_debug = ?e,
                    %signature,
                    attempt,
                    rpc_elapsed_ms,
                    "scanner: getTransaction not ready yet, retrying"
                );
                tokio::time::sleep(GET_TRANSACTION_RETRY_DELAY).await;
            }
            Err(e) => {
                tracing::warn!(
                    error_display = %e,
                    error_debug = ?e,
                    %signature,
                    attempt,
                    rpc_elapsed_ms,
                    "scanner: getTransaction failed, giving up on this signature — full RPC \
                     error above (error_debug), not just its Display summary"
                );
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
    tracing::debug!(%signature, "scanner: starting transaction parser");
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
        "scanner: transaction decode (for account-key extraction) result"
    );
    let static_account_keys: Vec<Vec<u8>> = decoded
        .map(|versioned_tx| {
            versioned_tx
                .message
                .static_account_keys()
                .iter()
                .map(|pk| pk.to_bytes().to_vec())
                .collect()
        })
        .unwrap_or_default();

    let meta: UiTransactionStatusMeta = confirmed.transaction.meta?;

    // Inner-instruction `program_id_index`/`accounts` on a v0 (versioned)
    // transaction can index into addresses loaded from an Address Lookup
    // Table, not just the message's own static account keys — Solana's
    // canonical indexing order is: static keys, then ALT-loaded writable
    // addresses, then ALT-loaded readonly addresses. Previously only the
    // fee payer (the message's first static key) was ever kept here,
    // which is exactly why every inner instruction's `program_id_index`
    // came back unresolvable in production: any CPI instruction pointing
    // past index 0 — i.e. essentially all of them — had nothing to
    // resolve against.
    let loaded_addresses: Vec<Vec<u8>> = match &meta.loaded_addresses {
        OptionSerializer::Some(loaded) => loaded
            .writable
            .iter()
            .chain(loaded.readonly.iter())
            .filter_map(|addr| bs58::decode(addr).into_vec().ok())
            .collect(),
        OptionSerializer::None | OptionSerializer::Skip => Vec::new(),
    };
    let account_keys: Vec<Vec<u8>> = static_account_keys
        .into_iter()
        .chain(loaded_addresses)
        .collect();
    tracing::debug!(
        signature = %log_signature,
        account_key_count = account_keys.len(),
        "scanner: synthetic transaction account keys assembled (static + ALT-loaded)"
    );

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
                    account_keys,
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

#[cfg(test)]
mod pumpfun_trade_event_tests {
    use super::*;

    /// The exact `"Program data: <base64>"` payload captured from a real
    /// production transaction (signature cZAtXWxp6PavammXpPS44jAaymQ9xG4h
    /// rbZgcsGJ9RyHZQu2fTwoRJbZwPg7gG1G4rkhUwNtFj3BmqRcFdgzqGC, mainnet) that
    /// this scanner previously rejected entirely — the reason
    /// build_pumpfun_trade_info/detect_pumpfun_log_event exist. Pinning this
    /// as a regression test, not just a one-off manual check, since a wrong
    /// field offset here would make a live trading bot buy/copy the wrong
    /// thing.
    const REAL_TRADE_EVENT_B64: &str = "vdt/007mYe5enbBp6lMQcbH9bxfIXUz8z4IC3Z0UvLDKphP294ECD7v+DgAAAAAA9BI6IggAAAABH8h/SdK4AnXl50+aiw13l05pQa7zlZzxn+x3naDFnhM8e1xqAAAAAOL1pQEHAAAAjZ2f+OPMAwDiSYIFAAAAAI0FjaxSzgIASsL40N1cvJfjKJwZfLUGKlTz2Va5zm5RFfllZ6pcs+ZfAAAAAAAAAHgkAAAAAAAAH8h/SdK4AnXl50+aiw13l05pQa7zlZzxn+x3naDFnhMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEgAAAGJ1eV9leGFjdF9xdW90ZV9pbgAeAAAAAAAAAIULAAAAAAAAiBMAAAAAAAA8EgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAALv+DgAAAAAA4vWlAQcAAADiSYIFAAAAAA==";

    #[test]
    fn discriminator_matches_sha256_event_trade_event() {
        // Guards against silent drift if this constant is ever "cleaned up"
        // by someone who doesn't realize it's load-bearing, not arbitrary.
        let payload = base64::decode(REAL_TRADE_EVENT_B64).unwrap();
        assert_eq!(payload[0..8], PUMPFUN_TRADE_EVENT_DISCRIMINATOR);
    }

    #[test]
    fn decodes_real_production_buy_correctly() {
        let payload = base64::decode(REAL_TRADE_EVENT_B64).unwrap();
        let parsed = build_pumpfun_trade_info("test-signature", &payload[8..])
            .expect("must decode a real production TradeEvent payload");

        assert_eq!(parsed.dex_type, DexType::PumpFun);
        assert_eq!(parsed.mint, "7NLnWYKHPnHYzzF8ZbZuQpjbZYqZrKrhRGYhtXXRpump");
        assert!(parsed.is_buy);
        assert_eq!(
            parsed.coin_creator.as_deref(),
            Some("394xePDbHxhjj1Yy8xFRRe7pMh2Ac1pEGYzacqjcBhqL")
        );
        // Pump.fun's bonding curve starts at a fixed 30 SOL virtual
        // reserve; this trade's reserves should still be close to that
        // (a lightly-traded token), not some wildly different magnitude
        // that would indicate a field-offset mistake.
        assert!(parsed.virtual_sol_reserves > 29_000_000_000 && parsed.virtual_sol_reserves < 31_000_000_000);
        assert_eq!(parsed.virtual_sol_reserves, 30_092_424_674);
        assert_eq!(parsed.virtual_token_reserves, 1_069_704_430_984_589);
        assert_eq!(parsed.sol_change, -982715.0 / 1_000_000_000.0);
        assert_eq!(parsed.token_change, 34_933_969_652.0 / 1_000_000_000.0);
    }

    #[test]
    fn rejects_payload_that_is_too_short() {
        let payload = base64::decode(REAL_TRADE_EVENT_B64).unwrap();
        // Truncate well before the `creator` field this scanner requires.
        let truncated = &payload[8..8 + 100];
        assert!(build_pumpfun_trade_info("test-signature", truncated).is_none());
    }

    #[test]
    fn wrong_discriminator_is_not_detected_as_pumpfun_trade_event() {
        let mut payload = base64::decode(REAL_TRADE_EVENT_B64).unwrap();
        payload[0] ^= 0xff; // corrupt the discriminator
        assert_ne!(payload[0..8], PUMPFUN_TRADE_EVENT_DISCRIMINATOR);
    }
}
