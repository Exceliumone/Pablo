//! One OS process per subscriber, spawned by the orchestrator
//! (`src/main.rs`) with an `ExecutorStartPayload` delivered via the
//! `EXECUTOR_CONFIG_JSON` env var. Never establishes its own Yellowstone
//! subscription — it tails the shared scanner's Redis stream and makes its
//! own buy/sell decisions using that one user's wallet and settings.
//!
//! Every trading call here (`execute_buy`, `SellingEngine::new`,
//! `update_metrics`, `evaluate_sell_conditions`, `unified_emergency_sell`)
//! is an unmodified public function/method from the engine crate, used
//! exactly as the engine's own top-level monitoring loop uses them. This
//! process being its own OS process is what makes that safe: the engine's
//! position-tracking globals (TOKEN_METRICS, BOUGHT_TOKEN_LIST, ...) are
//! keyed by mint only, with no user dimension, so they'd corrupt across
//! users inside a shared process — see docs/ARCHITECTURE.md.
//!
//! Two entry modes, chosen by `copy_trading_enabled` + a non-empty
//! `copy_trading_targets`:
//! - **Copy-trading**: only mints bought by a watched wallet are entered,
//!   and a watched wallet's own sell is mirrored immediately (independent
//!   of this position's own take-profit/stop-loss), matched via
//!   `ScannerTick::trader` (the tx fee payer, extracted by the scanner —
//!   see scanner.rs's `extract_trader_from_transaction`). This only ever
//!   sees a target's trades from the moment this executor started
//!   watching onward: there is no backfill of positions a target wallet
//!   already held before that (would need `getSignaturesForAddress` +
//!   historical parsing on startup — not implemented, since there's
//!   nothing to mirror-buy for a position whose entry already happened).
//! - **Generic sniper** (copy-trading disabled or no targets set): the
//!   v1 heuristic — buy the first tick seen for any not-yet-held mint,
//!   from any trader. Intentionally minimal (no honeypot/risk scoring
//!   yet — that's Sniper page territory for a later phase).
//! Either way, a held position's own take-profit/stop-loss/trailing-stop
//! exit (via `SellingEngine`) always keeps running regardless of what the
//! target wallet does next. Get this reviewed against real devnet activity
//! before relying on it.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anchor_client::solana_sdk::signature::{Keypair, Signer};
use engine_bridge::contract::{
    BotEvent, BotStatus, ExecutorStartPayload, ScannerTick, TradeSide, SCANNER_TICKS_STREAM,
};
use engine_bridge::events::{now_iso, publish_event};
use redis::streams::{StreamReadOptions, StreamReadReply};
use redis::AsyncCommands;
use solana_vntr_sniper::common::config::{
    create_nonblocking_rpc_client, create_rpc_client, create_zeroslot_rpc_client, AppState,
    SwapConfig,
};
use solana_vntr_sniper::library::blockhash_processor::BlockhashProcessor;
use solana_vntr_sniper::processor::selling_strategy::{SellingConfig, SellingEngine};
use solana_vntr_sniper::processor::swap::{SwapDirection, SwapInType, SwapProtocol};
use solana_vntr_sniper::processor::transaction_parser::{DexType, TradeInfoFromToken};

/// Logs enough of `redis_url` (scheme, host, port, logical DB index,
/// whether credentials are present) to let the *same-looking* but
/// different-Redis-instance bug be diagnosed from logs alone, without ever
/// logging a password. This executor's `redis_url` comes from
/// `apps/api`'s own `REDIS_URL` env var (relayed through
/// `ExecutorStartPayload`) — a completely separate `.env` file from the
/// one `apps/engine-bridge`'s `scanner`/orchestrator binaries read their
/// own `REDIS_URL` from. Both `redis::Client::open` calls succeed and
/// this process reports `RUNNING` either way, so if the two `.env` files
/// ever drift (different host, port, or logical DB index — `redis://
/// host:6379/0` vs `/1` is enough), the scanner and this executor connect
/// to two different Redis keyspaces: `XADD scanner:ticks` in one is
/// simply invisible to `XREAD` in the other, with no error anywhere. Log
/// this line from both processes and diff them.
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
        "executor: REDIS_URL shape (redacted — no password logged). Compare this exact line \
         against the scanner process's own \"scanner: REDIS_URL shape\" log (if present) or \
         directly against apps/engine-bridge/.env's REDIS_URL — this executor's redis_url comes \
         from apps/api's REDIS_URL instead (relayed via ExecutorStartPayload), a different .env \
         file. Any difference in host_port or db_index here means this executor is reading a \
         different Redis keyspace than the scanner writes to — it will look perfectly healthy \
         (RUNNING, no errors) while never seeing a single tick."
    );
}

fn dex_type_from_str(s: &str) -> DexType {
    match s {
        "PumpFun" => DexType::PumpFun,
        "PumpSwap" => DexType::PumpSwap,
        "RaydiumLaunchpad" => DexType::RaydiumLaunchpad,
        _ => DexType::Unknown,
    }
}

fn protocol_from_dex(dex: &DexType) -> SwapProtocol {
    match dex {
        DexType::PumpFun => SwapProtocol::PumpFun,
        DexType::PumpSwap => SwapProtocol::PumpSwap,
        DexType::RaydiumLaunchpad => SwapProtocol::RaydiumLaunchpad,
        DexType::Unknown => SwapProtocol::Auto,
    }
}

fn tick_to_trade_info(tick: &ScannerTick) -> TradeInfoFromToken {
    TradeInfoFromToken {
        dex_type: dex_type_from_str(&tick.dex_type),
        slot: tick.slot,
        signature: tick.signature.clone(),
        pool_id: tick.pool_id.clone(),
        mint: tick.mint.clone(),
        timestamp: tick.timestamp,
        is_buy: tick.is_buy,
        price: tick.price,
        is_reverse_when_pump_swap: tick.is_reverse_when_pump_swap,
        coin_creator: tick.coin_creator.clone(),
        sol_change: tick.sol_change,
        token_change: tick.token_change,
        liquidity: tick.liquidity,
        virtual_sol_reserves: tick.virtual_sol_reserves,
        virtual_token_reserves: tick.virtual_token_reserves,
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "executor=info".into()),
        )
        .json()
        .init();

    let payload_json = std::env::var("EXECUTOR_CONFIG_JSON")
        .map_err(|_| anyhow::anyhow!("executor: missing EXECUTOR_CONFIG_JSON"))?;
    let payload: ExecutorStartPayload = serde_json::from_str(&payload_json)?;
    let user_id = payload.user_id.clone();

    log_redacted_redis_url(&payload.redis_url);
    let redis_client = redis::Client::open(payload.redis_url.clone())?;
    let mut event_conn = redis_client.get_multiplexed_async_connection().await?;
    let mut stream_conn = redis_client.get_multiplexed_async_connection().await?;

    publish_event(
        &mut event_conn,
        &BotEvent::Status {
            user_id: user_id.clone(),
            status: BotStatus::Starting,
            at: now_iso(),
        },
    )
    .await;

    // Feed the engine's own env-driven client constructors a per-process
    // environment instead of a shared .env — this is the only "config
    // injection" seam, and it's plumbing, not trading logic.
    std::env::set_var("RPC_HTTP", &payload.rpc_http);
    std::env::set_var("ZERO_SLOT_URL", &payload.zero_slot_url);

    let init = async {
        let wallet = Arc::new(Keypair::from_base58_string(&payload.wallet_secret_key_b58));
        let rpc_client = create_rpc_client()?;
        let rpc_nonblocking_client = create_nonblocking_rpc_client().await?;
        let zeroslot_rpc_client = create_zeroslot_rpc_client().await?;

        let protocol_preference = match payload.settings.protocol_preference.as_str() {
            "pumpfun" => SwapProtocol::PumpFun,
            "pumpswap" => SwapProtocol::PumpSwap,
            "raydium" => SwapProtocol::RaydiumLaunchpad,
            _ => SwapProtocol::Auto,
        };

        let app_state = Arc::new(AppState {
            rpc_client,
            rpc_nonblocking_client,
            zeroslot_rpc_client,
            wallet,
            protocol_preference,
        });

        // Every buy/sell path in the engine (sniper_bot.rs, selling_strategy.rs,
        // transaction_retry.rs) reads the recent blockhash via a bare
        // `BlockhashProcessor::get_latest_blockhash()` against a 300ms-refreshed
        // process-global cache — but nothing populates that cache unless
        // `BlockhashProcessor::start()` has been called at least once in this
        // OS process. The engine's own standalone binary (engine/src/main.rs)
        // does call it, which is what made this easy to miss here: PABLO never
        // runs that binary — this `executor` process is what actually calls
        // execute_buy/execute_sell — so the cache stayed permanently empty and
        // every buy failed immediately with "Failed to get real-time
        // blockhash, skipping transaction". `get_fresh_blockhash()` right after
        // `start()` both verifies RPC connectivity up front (failing init
        // loudly here, the same way the rpc_client/wallet/zeroslot construction
        // above already does, instead of failing silently on the first live
        // trade) and warms the cache synchronously, closing the otherwise-
        // possible race where a copy-trading tick arrives and triggers a buy
        // before the background refresh loop's first 300ms tick has landed.
        let blockhash_processor = BlockhashProcessor::new(app_state.rpc_client.clone()).await?;
        blockhash_processor.start().await?;
        blockhash_processor.get_fresh_blockhash().await?;

        let swap_config = Arc::new(SwapConfig {
            swap_direction: SwapDirection::Buy,
            in_type: SwapInType::Qty,
            amount_in: payload.settings.amount_per_buy_sol,
            slippage: payload.settings.slippage_bps as u64,
        });

        let mut selling_config = SellingConfig::default();
        selling_config.take_profit = payload.settings.take_profit_pct;
        selling_config.stop_loss = payload.settings.stop_loss_pct;
        if let Some(trailing_pct) = payload.settings.trailing_stop_pct {
            selling_config.trailing_stop.activation_percentage = trailing_pct;
        }

        anyhow::Ok((app_state, swap_config, selling_config))
    }
    .await;

    let (app_state, swap_config, selling_config) = match init {
        Ok(v) => v,
        Err(e) => {
            publish_event(
                &mut event_conn,
                &BotEvent::Error {
                    user_id: user_id.clone(),
                    message: format!("initialization failed: {e}"),
                    at: now_iso(),
                },
            )
            .await;
            publish_event(
                &mut event_conn,
                &BotEvent::Status {
                    user_id: user_id.clone(),
                    status: BotStatus::Error,
                    at: now_iso(),
                },
            )
            .await;
            return Err(e);
        }
    };

    let selling_engine = SellingEngine::new(app_state.clone(), swap_config.clone(), selling_config);

    publish_event(
        &mut event_conn,
        &BotEvent::Status {
            user_id: user_id.clone(),
            status: BotStatus::Running,
            at: now_iso(),
        },
    )
    .await;
    tracing::info!(%user_id, "executor: running");

    let copy_targets: HashSet<String> = if payload.settings.copy_trading_enabled {
        payload
            .settings
            .copy_trading_targets
            .iter()
            .cloned()
            .collect()
    } else {
        HashSet::new()
    };
    let copy_trading_active = !copy_targets.is_empty();
    if copy_trading_active {
        tracing::info!(%user_id, target_count = copy_targets.len(), "executor: copy-trading mode — entries gated to watched wallets");
    }

    // mint -> estimated token amount held, derived from amount_sol / price_sol
    // at buy time. The engine's execute_buy/unified_emergency_sell return no
    // fill data, so this (and the amount_sol a sell reports below) is the
    // best available approximation of position size without engine changes.
    let mut held_positions: std::collections::HashMap<String, f64> =
        std::collections::HashMap::new();
    let mut last_id = "$".to_string();
    let read_opts = StreamReadOptions::default().block(5000).count(100);

    // Silent-forever-block watchdog: `xread_options` returning an empty
    // `reply.keys` (nothing new within the 5s block window) is completely
    // normal moment-to-moment — but if it stays empty for a long time
    // straight, that's indistinguishable from this executor being
    // connected to a *different* Redis keyspace than the scanner writes
    // `scanner:ticks` into (see `log_redacted_redis_url`'s doc comment):
    // no error, `RUNNING` status, just permanent silence. Logged once per
    // idle window rather than on every empty poll, which would otherwise
    // fire every 5s forever whenever there's genuinely nothing to trade.
    let mut last_tick_at = Instant::now();
    let mut idle_warning_logged = false;
    const IDLE_WARNING_THRESHOLD: Duration = Duration::from_secs(120);

    loop {
        let reply: redis::RedisResult<StreamReadReply> = stream_conn
            .xread_options(&[SCANNER_TICKS_STREAM], &[last_id.as_str()], &read_opts)
            .await;

        let reply = match reply {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "executor: redis read error, retrying");
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };

        if reply.keys.is_empty() {
            if !idle_warning_logged && last_tick_at.elapsed() > IDLE_WARNING_THRESHOLD {
                tracing::warn!(
                    idle_secs = last_tick_at.elapsed().as_secs(),
                    stream = SCANNER_TICKS_STREAM,
                    "executor: no new scanner ticks received in over {}s. If the scanner is \
                     confirmed to be publishing (its own logs show \"EMITTED\"), this almost \
                     certainly means this executor's REDIS_URL points to a different Redis \
                     instance/DB than the scanner's — see this process's \"executor: REDIS_URL \
                     shape\" log line near startup and compare it against the scanner's \
                     \"scanner: REDIS_URL shape\" line.",
                    IDLE_WARNING_THRESHOLD.as_secs()
                );
                idle_warning_logged = true;
            }
            continue;
        }

        for stream_key in reply.keys {
            for entry in stream_key.ids {
                last_id = entry.id.clone();
                last_tick_at = Instant::now();
                idle_warning_logged = false;

                let Some(raw) = entry.map.get("data") else {
                    continue;
                };
                let Ok(json) = redis::from_redis_value::<String>(raw) else {
                    continue;
                };
                let Ok(tick) = serde_json::from_str::<ScannerTick>(&json) else {
                    continue;
                };

                let trade_info = tick_to_trade_info(&tick);
                let is_held = held_positions.contains_key(&tick.mint);
                let is_from_target_wallet = copy_trading_active
                    && tick
                        .trader
                        .as_deref()
                        .is_some_and(|t| copy_targets.contains(t));

                // Copy-trading mode: mirror a watched wallet's own sell
                // immediately, independent of this position's own
                // take-profit/stop-loss — we're following their exit, not
                // making an independent one.
                if is_held && is_from_target_wallet && !tick.is_buy {
                    let protocol = protocol_from_dex(&trade_info.dex_type);
                    match selling_engine
                        .unified_emergency_sell(
                            &tick.mint,
                            false,
                            Some(&trade_info),
                            Some(protocol),
                        )
                        .await
                    {
                        Ok(signature) => {
                            let price_sol = tick.price as f64 / 1_000_000_000.0;
                            let amount_token = held_positions.remove(&tick.mint).unwrap_or(0.0);
                            let amount_sol = amount_token * price_sol;
                            publish_event(
                                &mut event_conn,
                                &BotEvent::Trade {
                                    user_id: user_id.clone(),
                                    side: TradeSide::Sell,
                                    mint: tick.mint.clone(),
                                    dex: tick.dex_type.clone(),
                                    price_sol,
                                    amount_sol,
                                    amount_token,
                                    tx_signature: Some(signature),
                                    reason: Some("copy_trade_sell".into()),
                                    at: now_iso(),
                                },
                            )
                            .await;
                        }
                        Err(e) => {
                            publish_event(
                                &mut event_conn,
                                &BotEvent::Error {
                                    user_id: user_id.clone(),
                                    message: format!(
                                        "copy-trade sell failed for {}: {e}",
                                        tick.mint
                                    ),
                                    at: now_iso(),
                                },
                            )
                            .await;
                        }
                    }
                    continue;
                }

                if is_held {
                    if let Err(e) = selling_engine.update_metrics(&tick.mint, &trade_info).await {
                        tracing::warn!(error = %e, mint = %tick.mint, "executor: update_metrics failed");
                        continue;
                    }
                    match selling_engine.evaluate_sell_conditions(&tick.mint).await {
                        Ok((should_sell, is_emergency)) if should_sell => {
                            let protocol = protocol_from_dex(&trade_info.dex_type);
                            match selling_engine
                                .unified_emergency_sell(
                                    &tick.mint,
                                    is_emergency,
                                    Some(&trade_info),
                                    Some(protocol),
                                )
                                .await
                            {
                                Ok(signature) => {
                                    let price_sol = tick.price as f64 / 1_000_000_000.0;
                                    let amount_token =
                                        held_positions.remove(&tick.mint).unwrap_or(0.0);
                                    let amount_sol = amount_token * price_sol;
                                    publish_event(
                                        &mut event_conn,
                                        &BotEvent::Trade {
                                            user_id: user_id.clone(),
                                            side: TradeSide::Sell,
                                            mint: tick.mint.clone(),
                                            dex: tick.dex_type.clone(),
                                            price_sol,
                                            amount_sol,
                                            amount_token,
                                            tx_signature: Some(signature),
                                            reason: Some(if is_emergency {
                                                "emergency".into()
                                            } else {
                                                "sell_condition".into()
                                            }),
                                            at: now_iso(),
                                        },
                                    )
                                    .await;
                                }
                                Err(e) => {
                                    publish_event(
                                        &mut event_conn,
                                        &BotEvent::Error {
                                            user_id: user_id.clone(),
                                            message: format!("sell failed for {}: {e}", tick.mint),
                                            at: now_iso(),
                                        },
                                    )
                                    .await;
                                }
                            }
                        }
                        Ok(_) => {}
                        Err(e) => {
                            tracing::warn!(error = %e, mint = %tick.mint, "executor: evaluate_sell_conditions failed");
                        }
                    }
                    continue;
                }

                // Not held yet. In copy-trading mode, only mirror an entry
                // when this tick is a watched wallet's own buy — everything
                // else (other wallets trading the same mint) is deliberately
                // ignored. Otherwise, the v1 heuristic is "buy the first
                // tick seen for a new mint," from any trader. See the
                // module doc comment.
                if copy_trading_active && !(is_from_target_wallet && tick.is_buy) {
                    continue;
                }

                publish_event(
                    &mut event_conn,
                    &BotEvent::Opportunity {
                        user_id: user_id.clone(),
                        mint: tick.mint.clone(),
                        dex: tick.dex_type.clone(),
                        price_sol: tick.price as f64 / 1_000_000_000.0,
                        liquidity_sol: tick.liquidity,
                        at: now_iso(),
                    },
                )
                .await;

                let protocol = protocol_from_dex(&trade_info.dex_type);
                tracing::info!(
                    %user_id,
                    mint = %tick.mint,
                    dex = %tick.dex_type,
                    protocol = ?protocol,
                    price_sol = tick.price as f64 / 1_000_000_000.0,
                    source_signature = %tick.signature,
                    trader = ?tick.trader,
                    amount_sol = swap_config.amount_in,
                    slippage_bps = swap_config.slippage,
                    "executor: STEP 1: Event received — dispatching buy attempt to engine::execute_buy"
                );
                match solana_vntr_sniper::processor::sniper_bot::execute_buy(
                    trade_info.clone(),
                    app_state.clone(),
                    swap_config.clone(),
                    protocol.clone(),
                )
                .await
                {
                    Ok(()) => {
                        let price_sol = tick.price as f64 / 1_000_000_000.0;
                        let amount_token = if price_sol > 0.0 {
                            swap_config.amount_in / price_sol
                        } else {
                            0.0
                        };
                        held_positions.insert(tick.mint.clone(), amount_token);
                        let _ = selling_engine.update_metrics(&tick.mint, &trade_info).await;
                        publish_event(
                            &mut event_conn,
                            &BotEvent::Trade {
                                user_id: user_id.clone(),
                                side: TradeSide::Buy,
                                mint: tick.mint.clone(),
                                dex: tick.dex_type.clone(),
                                price_sol,
                                amount_sol: swap_config.amount_in,
                                amount_token,
                                tx_signature: None,
                                reason: Some("auto_snipe".into()),
                                at: now_iso(),
                            },
                        )
                        .await;
                    }
                    Err(e) => {
                        // Every other failure path in this loop (copy-trade
                        // sell, take-profit/stop-loss sell) publishes a
                        // BotEvent::Error so the user can see why nothing
                        // happened — this one only logged at `debug`, which
                        // is invisible under the `RUST_LOG=info` this binary
                        // is always spawned with (see engine-bridge's
                        // main.rs `spawn_executor`). That made a persistent
                        // buy failure (e.g. the blockhash cache never being
                        // populated — since fixed) indistinguishable from
                        // "nothing to buy": the Sniper page kept showing
                        // "Nouveau token détecté" (BotEvent::Opportunity,
                        // published unconditionally just above, before this
                        // attempt) with no trade and no explanation ever
                        // following it.
                        // engine::execute_buy's own STEP 2-9 logs (relayed
                        // via this process's stdout, see main.rs's
                        // spawn_executor) carry the step-by-step detail;
                        // this is the final outcome plus the context needed
                        // to reproduce it (wallet, RPC, amount) without
                        // having to go dig those logs up.
                        let wallet_pubkey = app_state
                            .wallet
                            .try_pubkey()
                            .map(|pk| pk.to_string())
                            .unwrap_or_else(|_| "<unavailable>".to_string());
                        tracing::warn!(
                            error = %e,
                            mint = %tick.mint,
                            protocol = ?protocol,
                            wallet = %wallet_pubkey,
                            rpc_http = %payload.rpc_http,
                            amount_sol = swap_config.amount_in,
                            slippage_bps = swap_config.slippage,
                            "executor: buy failed"
                        );
                        publish_event(
                            &mut event_conn,
                            &BotEvent::Error {
                                user_id: user_id.clone(),
                                message: format!(
                                    "buy failed for {} (protocol={:?}, wallet={}, amount_sol={}): {e}",
                                    tick.mint, protocol, wallet_pubkey, swap_config.amount_in
                                ),
                                at: now_iso(),
                            },
                        )
                        .await;
                    }
                }
            }
        }
    }
}
