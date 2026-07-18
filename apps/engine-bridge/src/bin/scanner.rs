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
//!   Exists so this project can be developed and tested against any
//!   provider's free/standard RPC+WS tier — including Solana's own public
//!   endpoint (`https://api.mainnet-beta.solana.com` /
//!   `wss://api.mainnet-beta.solana.com`, zero cost, no account needed) —
//!   without also paying for a Yellowstone gRPC add-on. **Materially
//!   higher latency and lower throughput than production — see the
//!   module-level warning logged at startup, and the doc comment on
//!   `run_rpc_websocket` below. Not meant to run against real capital.**
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
use std::time::{Duration, Instant};

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
use solana_transaction_status::option_serializer::OptionSerializer;
use solana_transaction_status::{
    EncodedConfirmedTransactionWithStatusMeta, UiInnerInstructions, UiInstruction,
    UiTransactionEncoding, UiTransactionStatusMeta, UiTransactionTokenBalance,
};
use solana_vntr_sniper::dex::pump_fun::PUMP_FUN_PROGRAM;
use solana_vntr_sniper::dex::pump_swap::PUMP_SWAP_PROGRAM;
use solana_vntr_sniper::dex::raydium_launchpad::RAYDIUM_LAUNCHPAD_PROGRAM;
use solana_vntr_sniper::processor::transaction_parser::{
    parse_transaction_data, DexType, TradeInfoFromToken,
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
/// length matches one of these known instruction encodings. Shared by both
/// modes: once a `SubscribeUpdateTransaction` exists — straight off
/// Yellowstone, or hand-assembled from a standard `getTransaction` response
/// (see `to_synthetic_subscribe_update` below) — the rest of the detection
/// pipeline is identical. `log_signature` is diagnostic-only, matching the
/// convention already used by `detect_trade`/`fetch_and_detect`.
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

/// Turns one detected transaction into a trade tick. Tries the untouched
/// engine's own parser against a recognized inner-instruction CPI log
/// first (`extract_cpi_log_data` + `parse_transaction_data`, unchanged
/// behavior from before this file had a second path); if that finds
/// nothing, falls back to decoding a PumpSwap Anchor `"Program data:"` log
/// event (`detect_pumpswap_log_event`) before giving up. `None` for
/// anything neither path recognizes (wrapped-SOL mint, no matching CPI log
/// or log event, etc.). `log_signature` is diagnostic-only (a display
/// string identifying which transaction this call is for, so the
/// rejection-reason logs below can be correlated with the rest of the
/// pipeline's per-signature logs even when several are in flight
/// concurrently) — it plays no role in the detection logic itself.
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

    tracing::debug!(
        signature = %log_signature,
        "scanner: REJECTED — no inner instruction with a recognized CPI-log data length \
         (368/266/270/146/170/138 bytes), and no recognized PumpSwap Anchor log event \
         (SellEvent/BuyEvent) either. Either this transaction doesn't actually touch \
         PumpFun/PumpSwap/Raydium Launchpad in a way this scanner recognizes, or its emission \
         format has changed again."
    );
    None
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
        tracing::debug!(
            program = %program,
            raw_signature = %update.value.signature,
            "scanner: raw signature received from WebSocket, about to validate/convert"
        );
        let Ok(signature) = Signature::from_str(&update.value.signature) else {
            tracing::warn!(
                program = %program,
                raw_signature = %update.value.signature,
                "scanner: REJECTED — logsNotification signature failed to parse as a Signature"
            );
            continue;
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
                program = %program,
                raw_signature = %update.value.signature,
                "scanner: REJECTED — signature is the all-zero placeholder (Signature::default()), \
                 not a real transaction; sent by the RPC node itself in this logsNotification, \
                 skipping the getTransaction lookup"
            );
            continue;
        }
        tracing::debug!(
            program = %program,
            %signature,
            "scanner: signature accepted, dispatching getTransaction lookup"
        );

        let rpc_client = rpc_client.clone();
        let redis_conn = redis_conn.clone();
        let lookup_limiter = lookup_limiter.clone();
        let rate_limiter = rate_limiter.clone();
        let lookup_handle = tokio::spawn(async move {
            let Ok(_permit) = lookup_limiter.acquire().await else {
                tracing::warn!(
                    %signature,
                    "scanner: lookup_limiter semaphore was closed, dropping this signature \
                     without a getTransaction attempt"
                );
                return;
            };
            match fetch_and_detect(&rpc_client, signature, &rate_limiter).await {
                Some(tick) => publish_tick(&redis_conn, tick).await,
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

    anyhow::bail!("logs_subscribe stream(s) closed")
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
