use crate::contract::{executor_events_channel, BotEvent};
use redis::AsyncCommands;

/// Publishes one event to the per-user Redis pub/sub channel apps/api's WS
/// gateway subscribes to. Publish failures are logged, never fatal — a
/// dropped status update shouldn't take a trading loop down.
pub async fn publish_event(conn: &mut redis::aio::MultiplexedConnection, event: &BotEvent) {
    let user_id = match event {
        BotEvent::Status { user_id, .. }
        | BotEvent::Opportunity { user_id, .. }
        | BotEvent::Trade { user_id, .. }
        | BotEvent::Error { user_id, .. } => user_id.clone(),
    };

    let payload = match serde_json::to_string(event) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "failed to serialize bot event");
            return;
        }
    };

    if let Err(e) = conn
        .publish::<_, _, ()>(executor_events_channel(&user_id), payload)
        .await
    {
        tracing::warn!(error = %e, %user_id, "failed to publish bot event to redis");
    }
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}
