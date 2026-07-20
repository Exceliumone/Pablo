use crate::contract::{executor_events_channel, BotEvent, EXECUTOR_EVENTS_STREAM};
use redis::AsyncCommands;

/// Publishes one event both to the per-user Redis pub/sub channel apps/api's
/// WS gateway subscribes to (for live UI relay) and, for `Trade`/`Error`
/// events, to the durable `EXECUTOR_EVENTS_STREAM` apps/api's event-persister
/// reads via a consumer group (see that constant's doc comment for why
/// pub/sub alone isn't enough for anything that becomes a DB record).
/// `Status`/`Opportunity` stay pub/sub-only — high-frequency, disposable,
/// never persisted. Publish failures are logged, never fatal — a dropped
/// update shouldn't take a trading loop down.
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
        .publish::<_, _, ()>(executor_events_channel(&user_id), payload.clone())
        .await
    {
        tracing::warn!(error = %e, %user_id, "failed to publish bot event to redis");
    }

    if matches!(event, BotEvent::Trade { .. } | BotEvent::Error { .. }) {
        if let Err(e) = conn
            .xadd::<_, _, _, _, ()>(EXECUTOR_EVENTS_STREAM, "*", &[("data", payload)])
            .await
        {
            tracing::warn!(error = %e, %user_id, "failed to xadd bot event to durable stream");
        }
    }
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}
