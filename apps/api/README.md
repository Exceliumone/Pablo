# @pablo/api

Fastify backend — the intermediary between the web app, PostgreSQL/Redis, and
`engine-bridge` (the Rust control surface around the untouched trading engine).

## Shipped so far

**Phase 0 — skeleton.** Fastify boots, `/health` responds, env validated
with zod at startup, full data model in `prisma/schema.prisma`.

**Phase 1 — auth.** `src/modules/auth/`: Sign-In-With-Solana.
- `GET /auth/nonce?address=` — issues a one-time message to sign, stored in
  Redis (5 min TTL).
- `POST /auth/verify` — verifies the ed25519 signature (`tweetnacl`),
  creates the user on first login or resolves the existing one, opens a
  `Session` (rotating refresh token in an httpOnly cookie) and returns a
  short-lived JWT access token.
- `POST /auth/refresh` / `POST /auth/logout` — rotate/revoke the session.
- `POST /auth/wallets/link` (authenticated) — attach a second wallet to the
  current account instead of logging in as a new one.
- `GET /auth/me` — current user + linked wallets + subscription status.

Verified against a real local Postgres + Redis (not mocked): signup, replay
rejection on a spent nonce, bad-signature rejection, JWT-gated `/auth/me`,
cookie-based refresh rotation, multi-wallet linking, and post-logout refresh
rejection all pass.

**Phase 2 — subscription.** `src/modules/billing/`, `src/modules/admin/`.
- `PlatformConfig` (`src/modules/admin/platform-config.service.ts`): the
  single admin-editable row (price, $PABLO mint, holder threshold,
  duration, grace period, treasury wallet). Seeded once from env bootstrap
  defaults, cached in Redis with write-through invalidation.
  `GET/PUT /admin/config` — PUT requires the `ADMIN` role
  (`fastify.requireRole`); wallets listed in `ADMIN_WALLET_ADDRESSES` are
  auto-promoted on login.
- `subscription.service.ts`: `reconcileSubscriptionState` is a pure state
  machine (paid period + live $PABLO balance + grace period →
  ACTIVE/GRACE/EXPIRED) — 11 unit tests in
  `subscription.service.test.ts` (`pnpm test`), covering lapse-into-grace,
  grace expiry, `gracePeriodDays = 0`, regaining holder status mid-grace,
  and that `ADMIN_GRANT` subscriptions are never auto-modified.
- `holder.service.ts` / `payment.service.ts`: live $PABLO balance via
  `getParsedTokenAccountsByOwner`, and SOL payments via `@solana/pay`
  (`encodeURL`/`findReference`/`validateTransfer` against a Solana Pay
  `reference` keypair — never a plain memo string).
- `src/jobs/holder-sweep.ts`: periodic reconciliation for every user with a
  linked wallet, so a balance drop is caught even without the user opening
  the app (a single-process interval today — see docs/ARCHITECTURE.md §12
  for the Helius-webhook upgrade path once this needs to scale).

Verified: `GET/PUT /admin/config` (seed, role gate, cache invalidation,
validation) against a real Postgres/Redis, and the 11 state-machine tests.
**Not verifiable in this sandbox**: Solana RPC and the CoinGecko price API
are both blocked by network egress policy here, so the on-chain payment
confirmation and holder-balance happy paths couldn't be exercised
end-to-end — confirmed instead that both fail cleanly (sanitized 500, no
crash, real error still logged server-side) rather than leaking internal
detail. Test the live paths in an environment with Solana RPC access
before going to production.

**Phase 3 — bridge to the engine.** `src/modules/wallet/`,
`src/modules/bot/`, `src/ws/`.
- `wallet.service.ts`: custodial trading wallet per user
  (`getOrCreateTradingWallet` generates a `Keypair` on first use),
  secret key encrypted at rest with AES-256-GCM
  (`src/lib/wallet-crypto.ts`, key from `WALLET_ENCRYPTION_KEY` — an
  explicit placeholder for real KMS/Vault, documented as such in the
  source).
- `lib/engine-bridge-client.ts`: the only place in `apps/api` that talks
  to `engine-bridge` — a thin HTTP client (`start`/`stop`/`status`)
  against its internal, bearer-token-gated API.
- `bot.service.ts` / `bot.routes.ts`: `GET/PUT /bot/settings`,
  `POST /bot/start` (requires an ACTIVE subscription — 402 otherwise;
  provisions the trading wallet, decrypts its key in-process only, hands
  it plus RPC/Yellowstone/Redis config to the orchestrator),
  `POST /bot/stop`, `GET /bot/status`. Changing settings while the bot is
  running restarts the executor, since the engine only reads its config
  at boot (no hot-reload).
- `src/ws/gateway.ts`: `GET /ws?token=<jwt>` — relays each user's
  `executor:events:<userId>` Redis pub/sub channel straight to their
  browser socket. Query-param auth because the native WebSocket API
  can't set custom headers; invalid/missing tokens close with 4401.

Verified against a real local Postgres/Redis: settings CRUD (including a
`priorityFeeLamports` BigInt-serialization bug found and fixed via live
testing), subscription gating on `/bot/start`, the orchestrator spawning
a real executor process against the real `engine` crate (a genuine
`execute_buy` call observed), the Redis Stream → pub/sub → WebSocket
relay carrying real events end-to-end, and JWT rejection on the socket.
**Not verifiable in this sandbox**: actual Yellowstone gRPC connectivity
and actual on-chain execution — Solana RPC/gRPC is blocked by network
egress policy here. Test both on Devnet before Mainnet.

**Phase 4 — trading dashboard.** `src/jobs/event-persister.ts`,
`src/modules/portfolio/`, `src/modules/trades/`, `src/modules/analytics/`,
plus the rest of `src/modules/wallet/`.
- `event-persister.ts`: the one process-wide Redis subscriber (started
  once at boot, unlike `ws/gateway.ts`'s one-per-connection) that
  PSUBSCRIBEs `executor:events:*` and turns `trade`/`error` events into
  `Trade` + `Position` + `Notification` rows. A BUY opens or averages into
  a `Position`; a SELL closes it and computes `realizedPnlSol`. Processing
  is serialized onto a single promise chain — ioredis fires `pmessage`
  handlers without waiting for the previous one, and a same-tick
  buy-then-sell (the v1 heuristic can react in milliseconds) could
  otherwise have the SELL's "find the open position" query race the BUY's
  still-in-flight insert; this was an actual bug caught via live testing,
  not a theoretical one.
- `portfolio.service.ts`: `GET /portfolio` — all open positions plus the
  50 most recently closed, with a `summary` that's a true aggregate over
  *all* history (not just what's returned). No live price feed yet, so
  only realized PnL is reported, never a fabricated unrealized number.
- `trades.service.ts`: `GET /trades` — cursor-paginated (not offset), so
  a live-growing history never skips or repeats a row between page
  fetches.
- `analytics.service.ts`: `GET /analytics/summary` — trade counts, win
  rate, best/worst trade, average hold time, and a 14-day realized-PnL
  series, computed in-process (fine at today's per-user scale).
- `wallet.service.ts` / `wallet.routes.ts`: `GET /wallet` (SOL + $PABLO
  balance, best-effort — `null` rather than a thrown error where RPC is
  unavailable) and `POST /wallet/withdraw` (a guarded `SystemProgram`
  transfer out of the custodial wallet; refuses while the bot is running,
  since the executor holds a long-lived connection signing with the same
  key and racing a manual transfer against an in-flight trade is exactly
  the kind of bug worth preventing outright).

Verified against a real local Postgres/Redis by injecting real
`BotEvent::Trade` payloads over Redis pub/sub and confirming the full
pipeline: positions opening/averaging/closing with correct PnL, cursor
pagination, analytics aggregation, and — after finding and fixing the
race above — a rapid-fire buy-then-sell closing correctly every time.
`POST /wallet/withdraw`'s guard (bot-must-be-stopped) was verified
directly; the transfer itself was verified to fail cleanly (sanitized
500) when it reaches Solana RPC, which this sandbox's network policy
blocks. **Not verifiable in this sandbox**: live SOL/$PABLO balances and
an actual on-chain withdrawal — test both on Devnet before Mainnet.

**Phase 6 — admin console.** `src/lib/audit.ts`, six new
`src/modules/admin/*.service.ts` + `*.routes.ts` pairs, all mounted under
`GET/PUT /admin/config`'s existing `admin.routes.ts` behind a nested
`preHandler` so only `/admin/config` stays public and everything else
requires the `ADMIN` role.
- `users.service.ts`: `GET /admin/users` (cursor-paginated roster),
  `GET /admin/users/:id` (detail incl. trading wallet pubkey, bot active
  flag, trade count), `PATCH /admin/users/:id` (role/status — refuses to
  let an admin change their own role, a cheap guard against a full
  self-lockout).
- `subscriptions.service.ts`: `GET /admin/subscriptions` (filterable by
  status), `POST /admin/subscriptions/:id/grant` (Premium as
  `ADMIN_GRANT`, N days), `POST /admin/subscriptions/:id/revoke`. Revoke
  sets the safe EXPIRED/FREE baseline in the same write that clears the
  grant, then best-effort reconciles upward (a real payment period or
  genuine holder balance can still restore ACTIVE) — **not** "clear the
  grant and hope reconciliation fixes the status," which was the original
  implementation and a real bug: reconciliation needs a live $PABLO RPC
  call and can throw outright, so revoke was silently not revoking
  anything whenever RPC was unavailable. Caught live, fixed, reverified.
- `holders.service.ts`: `GET /admin/holders` — reads the last-persisted
  `HolderSnapshot` rows (summed per user across wallets) rather than
  re-triggering `checkHolderStatus`'s live RPC fan-out on every page load;
  this is a monitoring view of what's already been observed, not a live
  probe. `balanceHuman`/`meetsThreshold` degrade to `null` when the
  mint-decimals RPC lookup is unavailable, same pattern as `wallet.service.ts`.
- `stats.service.ts`: `GET /admin/stats` — user/subscription/trade
  aggregates plus a live bots-running count from `engine-bridge`
  (`null` when the orchestrator is unreachable, never a false zero).
- `logs.service.ts`: `GET /admin/logs` — reads the `AuditLog` table, which
  nothing wrote to before this phase. `lib/audit.ts`'s `logAudit()` is now
  called from every admin mutation (`user.update`, `subscription.grant`,
  `subscription.revoke`) and retrofitted onto `platform-config.service.ts`'s
  `updatePlatformConfig` (Phase 2, previously unaudited).
- `executors.service.ts`: `GET /admin/executors` — proxies
  `engine-bridge`'s `GET /internal/executors` (already existed, unused by
  anything until now) via a new `listExecutors()` in
  `lib/engine-bridge-client.ts`. Reports `{ executors: [], reachable: false }`
  rather than a 500 when the orchestrator is down.

Verified against a real local Postgres/Redis **and** a real running
`engine-bridge` orchestrator (`cargo run --bin engine-bridge`): promoted a
test user to ADMIN, exercised every endpoint above by hand, and — the
strongest check — started a real executor via `POST /bot/start` and
watched `GET /admin/executors` correctly report it moving
STARTING → RUNNING → STOPPED, matching exactly what the orchestrator's own
Redis-subscription self-healing (Phase 3) reports. Also verified the
ADMIN-role gate rejects a non-admin JWT with 403, and that role/status
changes, grants, and revokes all land in `GET /admin/logs`.
**Not verifiable in this sandbox**: live $PABLO holder balances, since
Solana RPC is blocked here — the holders view degrades to "never
checked" instead of guessing.

## Local dev

```bash
cp .env.example .env
docker compose -f ../../infra/docker-compose.yml up -d postgres redis
# or, if you already have Postgres/Redis running locally, just point
# DATABASE_URL / REDIS_URL at them in .env
pnpm --filter @pablo/api prisma:generate
pnpm --filter @pablo/api prisma:migrate   # first run only
pnpm --filter @pablo/api dev
```

`engine-bridge` (the Rust orchestrator) needs to be running separately for
`/bot/*` routes and the admin Executors page to do anything beyond
validation — see the root README's "Local dev" section.

Every domain module from the original roadmap is now shipped — the
remaining work (Phase 7) is load/security/end-to-end hardening, not new
modules. See `docs/ARCHITECTURE.md` at the repo root.
