//! The plugin contract: every type here is either serialized over the
//! internal HTTP control API (orchestrator <-> apps/api) or over Redis
//! (scanner -> executor ticks, executor -> apps/api events). Mirrors
//! packages/shared-types/src/dto.ts's bot* schemas by hand — kept in sync
//! manually since there's no cross-language codegen here, but the shape is
//! deliberately flat/minimal specifically so that stays easy.
//!
//! Any future engine (this one, a rewrite, a different language entirely)
//! is a valid drop-in replacement for PABLO's control layer as long as it
//! speaks this same contract. apps/api and apps/web never reach past it.

use serde::{Deserialize, Serialize};

pub const SCANNER_TICKS_STREAM: &str = "scanner:ticks";
pub fn executor_events_channel(user_id: &str) -> String {
    format!("executor:events:{user_id}")
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum BotStatus {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
}

/// Everything an `executor` process needs to run for exactly one user.
/// Delivered once at spawn time via the `EXECUTOR_CONFIG_JSON` env var —
/// never written to disk, never logged. The orchestrator re-sends this on
/// every start (including implicit restarts after a settings change), so
/// the executor process itself stays fully stateless about *how* it got
/// its config.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutorStartPayload {
    pub user_id: String,

    /// Base58 secret key of this user's trading wallet. Decrypted by
    /// apps/api (see wallet.service.ts) immediately before this payload is
    /// built; held in this process's memory only for its lifetime.
    pub wallet_secret_key_b58: String,

    /// Standard Solana JSON-RPC HTTP endpoint — the public official RPC by
    /// default, or any other free/paid provider. No Yellowstone gRPC or
    /// other paid-provider-specific field exists here by design: this
    /// executor never establishes its own detection subscription (it tails
    /// the shared scanner's Redis stream — see executor.rs's module doc),
    /// and the scanner itself is public-RPC-only.
    pub rpc_http: String,
    /// Required by the engine's AppState even when zeroslot landing isn't
    /// used — its lazy static loader hangs forever if unset, so the
    /// orchestrator always fills this (falling back to a harmless
    /// placeholder rather than leaving it empty).
    pub zero_slot_url: String,

    pub redis_url: String,

    pub settings: BotSettingsPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotSettingsPayload {
    pub amount_per_buy_sol: f64,
    pub take_profit_pct: f64,
    pub stop_loss_pct: f64,
    pub trailing_stop_pct: Option<f64>,
    pub priority_fee_lamports: u64,
    pub slippage_bps: u16,
    pub auto_sell: bool,
    pub copy_trading_enabled: bool,
    pub copy_trading_targets: Vec<String>,
    pub protocol_preference: String,
}

/// One parsed on-chain trade tick, published by the scanner for every
/// transaction it sees on the watched DEX programs — this is the single
/// shared detection feed. Doubles as both "a new mint just traded for the
/// first time" (opportunity signal) and "here's a fresh price for a mint
/// you hold" (sell-monitoring signal); consumers decide which they care
/// about.
///
/// Field-for-field mirror of the engine's (unmodified, private-to-its-
/// crate-in-serde-terms) `transaction_parser::TradeInfoFromToken` — it
/// doesn't derive Serialize, so this is how its data crosses the Redis
/// wire; `executor` reconstructs a real `TradeInfoFromToken` literal from
/// these fields (all of that struct's fields are `pub`) before handing it
/// to the engine's own `SellingEngine`/`execute_buy`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScannerTick {
    pub dex_type: String, // Debug-formatted engine::DexType — "PumpFun" | "PumpSwap" | "RaydiumLaunchpad" | "Unknown"
    pub slot: u64,
    pub signature: String,
    pub pool_id: String,
    pub mint: String,
    pub timestamp: u64,
    pub is_buy: bool,
    pub price: u64,
    pub is_reverse_when_pump_swap: bool,
    pub coin_creator: Option<String>,
    pub sol_change: f64,
    pub token_change: f64,
    pub liquidity: f64,
    pub virtual_sol_reserves: u64,
    pub virtual_token_reserves: u64,

    /// Base58 pubkey of the transaction's fee payer (by Solana convention,
    /// the first account key in the message) — i.e. whoever actually made
    /// this trade. `None` when it couldn't be determined (should be rare;
    /// see scanner.rs's extract_trader_from_transaction). This is what lets
    /// `executor` match a tick against `copy_trading_targets` instead of
    /// just reacting to any trade on any watched DEX program.
    pub trader: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum BotEvent {
    Status {
        user_id: String,
        status: BotStatus,
        at: String,
    },
    Opportunity {
        user_id: String,
        mint: String,
        dex: String,
        price_sol: f64,
        liquidity_sol: f64,
        at: String,
    },
    Trade {
        user_id: String,
        side: TradeSide,
        mint: String,
        dex: String,
        price_sol: f64,
        /// SOL side of the trade. On a buy this is the configured spend
        /// (exact). On a sell this is `amount_token * price_sol` at the
        /// sell tick — an estimate, since `unified_emergency_sell` doesn't
        /// return actual fill data. See the Trade model doc comment in
        /// apps/api/prisma/schema.prisma.
        amount_sol: f64,
        /// Token side of the trade, estimated the same way: `amount_sol /
        /// price_sol` at the buy tick, tracked forward to the matching sell.
        amount_token: f64,
        tx_signature: Option<String>,
        reason: Option<String>,
        at: String,
    },
    Error {
        user_id: String,
        message: String,
        at: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum TradeSide {
    Buy,
    Sell,
}

/// In-memory view the orchestrator keeps per user, exposed at
/// GET /internal/executors/:userId and GET /internal/executors.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutorStatusView {
    pub user_id: String,
    pub status: BotStatus,
    pub pid: Option<u32>,
    pub started_at: Option<String>,
    pub last_event_at: Option<String>,
    pub last_error: Option<String>,
    pub restart_count: u32,
}
