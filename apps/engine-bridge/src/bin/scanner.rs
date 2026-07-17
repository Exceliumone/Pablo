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
    InnerInstruction, InnerInstructions, TokenBalance, TransactionStatusMeta, UiTokenAmount,
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
            run_rpc_websocket(env("RPC_HTTP"), env("SOLANA_WS_URL"), redis_conn).await
        }
    }
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

fn to_scanner_tick(parsed: &TradeInfoFromToken) -> ScannerTick {
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
    }
}

async fn publish_tick(redis_conn: &RedisConn, tick: ScannerTick) {
    let Ok(payload) = serde_json::to_string(&tick) else {
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
    if let Err(e) = result {
        tracing::warn!(error = %e, "scanner: failed to publish tick");
    }
}

/// Turns one detected transaction into a trade tick using exactly the
/// untouched engine's own parser. `None` for anything that isn't a
/// recognized trade (no matching CPI log, wrapped-SOL mint, etc.) — the
/// same filtering both modes already applied inline before this was
/// extracted out of `main()`.
fn detect_trade(txn: &SubscribeUpdateTransaction) -> Option<ScannerTick> {
    let data = extract_cpi_log_data(txn)?;
    let parsed = parse_transaction_data(txn, &data)?;
    if parsed.mint == "So11111111111111111111111111111111111111112" {
        return None;
    }
    Some(to_scanner_tick(&parsed))
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

        let Some(tick) = detect_trade(txn) else {
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

/// Runs one `logsSubscribe` per watched program (Solana's reference RPC
/// implementation's `mentions` filter only ever reliably supports a single
/// address per subscription — most providers, Chainstack included, follow
/// that same reference behavior) plus a bounded pool of `getTransaction`
/// follow-ups. See this file's module doc comment for the latency/quota
/// tradeoffs versus `run_yellowstone` above.
async fn run_rpc_websocket(
    rpc_http: String,
    solana_ws_url: String,
    redis_conn: RedisConn,
) -> anyhow::Result<()> {
    let rpc_client = Arc::new(RpcClient::new(rpc_http));
    let lookup_limiter = Arc::new(Semaphore::new(MAX_CONCURRENT_LOOKUPS));

    let mut handles = Vec::new();
    for program in watched_programs() {
        let solana_ws_url = solana_ws_url.clone();
        let rpc_client = rpc_client.clone();
        let redis_conn = redis_conn.clone();
        let lookup_limiter = lookup_limiter.clone();

        handles.push(tokio::spawn(async move {
            loop {
                if let Err(e) = watch_program_logs(
                    &solana_ws_url,
                    &program,
                    rpc_client.clone(),
                    redis_conn.clone(),
                    lookup_limiter.clone(),
                )
                .await
                {
                    tracing::warn!(
                        error = %e,
                        program = %program,
                        "scanner: logsSubscribe stream for this program ended, reconnecting in 5s"
                    );
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }));
    }

    tracing::info!(
        "scanner: subscribed (development mode), watching PumpFun / PumpSwap / Raydium Launchpad"
    );
    futures_util::future::join_all(handles).await;
    Ok(())
}

/// One `logsSubscribe` subscription for a single program. Runs until the
/// stream ends or errors, then returns — `run_rpc_websocket`'s caller loop
/// reconnects it. Each detected (non-failed) log spawns its own bounded
/// `getTransaction` + parse + publish task so one slow lookup can't stall
/// the next log notification from being received.
async fn watch_program_logs(
    solana_ws_url: &str,
    program: &str,
    rpc_client: Arc<RpcClient>,
    redis_conn: RedisConn,
    lookup_limiter: Arc<Semaphore>,
) -> anyhow::Result<()> {
    let pubsub = PubsubClient::new(solana_ws_url).await?;
    let (mut stream, _unsubscribe) = pubsub
        .logs_subscribe(
            RpcTransactionLogsFilter::Mentions(vec![program.to_string()]),
            RpcTransactionLogsConfig {
                commitment: Some(CommitmentConfig::processed()),
            },
        )
        .await?;

    while let Some(update) = stream.next().await {
        if update.value.err.is_some() {
            continue; // matches the Yellowstone filter's `failed: Some(false)`
        }
        let Ok(signature) = Signature::from_str(&update.value.signature) else {
            continue;
        };

        let rpc_client = rpc_client.clone();
        let redis_conn = redis_conn.clone();
        let lookup_limiter = lookup_limiter.clone();
        tokio::spawn(async move {
            let Ok(_permit) = lookup_limiter.acquire().await else {
                return;
            };
            if let Some(tick) = fetch_and_detect(&rpc_client, signature).await {
                publish_tick(&redis_conn, tick).await;
            }
        });
    }

    anyhow::bail!("logs_subscribe stream closed")
}

/// Fetches the full transaction via `getTransaction` (retrying through the
/// normal confirm delay — see `GET_TRANSACTION_RETRIES`'s doc comment),
/// then runs it through the exact same `detect_trade` pipeline Yellowstone
/// mode uses.
async fn fetch_and_detect(rpc_client: &RpcClient, signature: Signature) -> Option<ScannerTick> {
    let mut confirmed: Option<EncodedConfirmedTransactionWithStatusMeta> = None;
    for attempt in 0..GET_TRANSACTION_RETRIES {
        let config = RpcTransactionConfig {
            encoding: Some(UiTransactionEncoding::Base64),
            commitment: Some(CommitmentConfig::confirmed()),
            max_supported_transaction_version: Some(0),
        };
        match rpc_client
            .get_transaction_with_config(&signature, config)
            .await
        {
            Ok(tx) => {
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

    let txn = to_synthetic_subscribe_update(confirmed?)?;
    detect_trade(&txn)
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
) -> Option<SubscribeUpdateTransaction> {
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
            transaction: None,
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
