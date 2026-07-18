# engine-bridge

The control surface around the untouched trading engine (`../../engine`).

- **Today (Phase 0):** a health/version skeleton, wired as a Cargo workspace
  member that path-depends on the `engine` crate, so the link between "new
  code" and "existing engine" is established from commit one.
- **Phase 3:** two binaries built from this crate —
  - `scanner` — runs DEX detection exactly once for the whole platform
    (one WebSocket subscription over standard Solana JSON-RPC — the free
    public RPC by default, no paid gRPC provider, never duplicated per
    user), publishing detected opportunities to a Redis stream.
  - `executor` — one isolated process per active subscriber, consuming that
    stream, applying that user's `BotSettings`, and signing trades with that
    user's trading wallet. Exposes `PUT /config`, `POST /control/start`,
    `POST /control/stop`, `GET /events` (WS) to the Node backend orchestrator.

See `docs/ARCHITECTURE.md` at the repo root for the full design and the
rationale for this split (it's what keeps per-user infra cost flat instead of
scaling linearly with subscriber count).
