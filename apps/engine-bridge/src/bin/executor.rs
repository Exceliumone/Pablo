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
//! v1 entry heuristic: buy the first tick seen for any not-yet-held mint.
//! This is intentionally minimal (no honeypot/risk scoring yet — that's
//! Sniper page territory for a later phase) and copy-trading target
//! matching is a documented no-op for now (the engine's parsed trade data
//! doesn't carry the transaction signer, only pool/price data — matching
//! against `copy_trading_targets` needs that added, see the TODO below).
//! Get this reviewed against real devnet activity before relying on it.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use anchor_client::solana_sdk::signature::Keypair;
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
use solana_vntr_sniper::processor::selling_strategy::{SellingConfig, SellingEngine};
use solana_vntr_sniper::processor::swap::{SwapDirection, SwapInType, SwapProtocol};
use solana_vntr_sniper::processor::transaction_parser::{DexType, TradeInfoFromToken};

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

    // TODO(copy-trading): TradeInfoFromToken carries no transaction signer,
    // only pool/price data, so `copy_trading_targets` can't be matched yet
    // from scanner ticks alone. Wiring this needs the scanner to also
    // extract+publish the fee payer (the engine has
    // extract_signer_from_transaction for this, currently private to
    // sniper_bot.rs). Left as a follow-up rather than silently
    // half-implemented.
    let _copy_targets: HashSet<String> = payload.settings.copy_trading_targets.iter().cloned().collect();

    // mint -> estimated token amount held, derived from amount_sol / price_sol
    // at buy time. The engine's execute_buy/unified_emergency_sell return no
    // fill data, so this (and the amount_sol a sell reports below) is the
    // best available approximation of position size without engine changes.
    let mut held_positions: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    let mut last_id = "$".to_string();
    let read_opts = StreamReadOptions::default().block(5000).count(100);

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

        for stream_key in reply.keys {
            for entry in stream_key.ids {
                last_id = entry.id.clone();

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

                if is_held {
                    if let Err(e) = selling_engine.update_metrics(&tick.mint, &trade_info).await {
                        tracing::warn!(error = %e, mint = %tick.mint, "executor: update_metrics failed");
                        continue;
                    }
                    match selling_engine.evaluate_sell_conditions(&tick.mint).await {
                        Ok((should_sell, is_emergency)) if should_sell => {
                            let protocol = protocol_from_dex(&trade_info.dex_type);
                            match selling_engine
                                .unified_emergency_sell(&tick.mint, is_emergency, Some(&trade_info), Some(protocol))
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
                                            reason: Some(if is_emergency { "emergency".into() } else { "sell_condition".into() }),
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

                // Not held yet: the v1 entry heuristic is "buy the first
                // tick seen for a new mint." See the module doc comment.
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
                match solana_vntr_sniper::processor::sniper_bot::execute_buy(
                    trade_info.clone(),
                    app_state.clone(),
                    swap_config.clone(),
                    protocol,
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
                        tracing::debug!(error = %e, mint = %tick.mint, "executor: buy skipped/failed");
                    }
                }
            }
        }
    }
}
