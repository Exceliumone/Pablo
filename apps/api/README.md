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
