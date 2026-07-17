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

Domain modules still to come (`billing`, `orchestrator`, `sniper`,
`portfolio`, `trades`, `notifications`, `admin`) land one roadmap phase at a
time — see `docs/ARCHITECTURE.md` at the repo root.
