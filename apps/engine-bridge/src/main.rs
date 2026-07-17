//! engine-bridge: the only new surface added around the untouched trading
//! engine (`solana-vntr-sniper`, imported at `engine/`).
//!
//! Phase 0 scope: a health-checkable HTTP skeleton the orchestrator can poll.
//! Phase 3 adds the real surface described in docs/ARCHITECTURE.md:
//!   - `scanner` binary: runs DEX/mempool detection once, shared by all users,
//!     publishes opportunities to Redis.
//!   - `executor` binary: one process per subscriber, applies that user's
//!     `BotSettings` and signs trades with that user's trading wallet.
//!   - PUT /config, POST /control/start|stop, GET /events (WS) on each executor.

use axum::{routing::get, Json, Router};
use serde::Serialize;
use std::net::SocketAddr;

#[derive(Serialize)]
struct Health {
    status: &'static str,
    service: &'static str,
}

#[derive(Serialize)]
struct Version {
    engine_bridge: &'static str,
    // Proves the workspace dependency on the untouched engine crate resolves.
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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "engine_bridge=info,tower_http=info".into()),
        )
        .json()
        .init();

    let app = Router::new()
        .route("/health", get(health))
        .route("/version", get(version))
        .layer(tower_http::trace::TraceLayer::new_for_http());

    let port: u16 = std::env::var("ENGINE_BRIDGE_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8090);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));

    tracing::info!(%addr, "engine-bridge listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
