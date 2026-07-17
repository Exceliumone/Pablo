//! The shared, singleton detection process. Exactly one instance ever runs
//! (an operational invariant enforced by the orchestrator/deployment, not
//! by this binary) — subscribes once to Yellowstone gRPC for the watched
//! DEX programs and republishes every parsed trade as a `ScannerTick` on a
//! Redis Stream that any number of `executor` processes can tail
//! independently. This is what keeps per-subscriber infra cost flat
//! instead of scaling with the number of users (see docs/ARCHITECTURE.md
//! §1, Décision A).
//!
//! Reuses exactly one function from the untouched engine crate:
//! `transaction_parser::parse_transaction_data`. It never calls
//! execute_buy/execute_sell or touches the engine's position-tracking
//! globals — this process makes no trading decisions, it only observes.

use std::sync::Arc;
use std::time::Duration;

use engine_bridge::contract::{ScannerTick, SCANNER_TICKS_STREAM};
use futures_util::{SinkExt, StreamExt};
use redis::AsyncCommands;
use solana_vntr_sniper::dex::pump_fun::PUMP_FUN_PROGRAM;
use solana_vntr_sniper::dex::pump_swap::PUMP_SWAP_PROGRAM;
use solana_vntr_sniper::dex::raydium_launchpad::RAYDIUM_LAUNCHPAD_PROGRAM;
use solana_vntr_sniper::processor::transaction_parser::parse_transaction_data;
use tokio::sync::Mutex;
use yellowstone_grpc_client::{ClientTlsConfig, GeyserGrpcClient};
use yellowstone_grpc_proto::geyser::{
    subscribe_update::UpdateOneof, CommitmentLevel, SubscribeRequest,
    SubscribeRequestFilterTransactions, SubscribeRequestPing,
};

fn env(key: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| panic!("scanner: missing required env var {key}"))
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

    let yellowstone_grpc_http = env("YELLOWSTONE_GRPC_HTTP");
    let yellowstone_grpc_token = env("YELLOWSTONE_GRPC_TOKEN");
    let redis_url = env("REDIS_URL");

    let redis_client = redis::Client::open(redis_url)?;
    let redis_conn = Arc::new(Mutex::new(
        redis_client.get_multiplexed_async_connection().await?,
    ));

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

    let dexs = vec![
        PUMP_FUN_PROGRAM.to_string(),
        PUMP_SWAP_PROGRAM.to_string(),
        RAYDIUM_LAUNCHPAD_PROGRAM.to_string(),
    ];
    let subscription_request = SubscribeRequest {
        transactions: maplit::hashmap! {
            "All".to_owned() => SubscribeRequestFilterTransactions {
                vote: Some(false),
                failed: Some(false),
                signature: None,
                account_include: dexs,
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

        // Same extraction pattern as the engine's own
        // process_message_for_dex_monitoring: the CPI log carrying the
        // trade payload is the inner instruction whose data length matches
        // one of these known instruction encodings.
        let inner_instructions = txn
            .transaction
            .as_ref()
            .and_then(|t| t.meta.as_ref())
            .map(|m| m.inner_instructions.clone())
            .unwrap_or_default();

        let cpi_log_data = inner_instructions
            .iter()
            .flat_map(|inner| &inner.instructions)
            .find(|ix| matches!(ix.data.len(), 368 | 266 | 270 | 146 | 170 | 138))
            .map(|ix| ix.data.clone());

        let Some(data) = cpi_log_data else { continue };
        let Some(parsed) = parse_transaction_data(txn, &data) else {
            continue;
        };

        if parsed.mint == "So11111111111111111111111111111111111111112" {
            continue;
        }

        let tick = ScannerTick {
            dex_type: format!("{:?}", parsed.dex_type),
            slot: parsed.slot,
            signature: parsed.signature,
            pool_id: parsed.pool_id,
            mint: parsed.mint,
            timestamp: parsed.timestamp,
            is_buy: parsed.is_buy,
            price: parsed.price,
            is_reverse_when_pump_swap: parsed.is_reverse_when_pump_swap,
            coin_creator: parsed.coin_creator,
            sol_change: parsed.sol_change,
            token_change: parsed.token_change,
            liquidity: parsed.liquidity,
            virtual_sol_reserves: parsed.virtual_sol_reserves,
            virtual_token_reserves: parsed.virtual_token_reserves,
        };

        let redis_conn = redis_conn.clone();
        tokio::spawn(async move {
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
        });
    }

    tracing::warn!("scanner: stream ended");
    Ok(())
}
