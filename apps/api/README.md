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
`/bot/*` routes to do anything beyond validation — see the root README's
"Local dev" section.

The `admin` dashboard (Phase 5's console: users, holders, licenses, stats,
logs) is the one domain module left — see `docs/ARCHITECTURE.md` at the
repo root.
