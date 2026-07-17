# @pablo/api

Fastify backend — the intermediary between the web app, PostgreSQL/Redis, and
`engine-bridge` (the Rust control surface around the untouched trading engine).

## Phase 0 scope

- Fastify boots, `/health` responds, env is validated with zod at startup.
- Full data model in `prisma/schema.prisma` (not yet migrated against a live DB
  in this phase — see `infra/docker-compose.yml` to bring up Postgres/Redis
  locally, then `pnpm prisma:migrate`).

## Local dev

```bash
cp .env.example .env
docker compose -f ../../infra/docker-compose.yml up -d postgres redis
pnpm --filter @pablo/api prisma:generate
pnpm --filter @pablo/api dev
```

Domain modules (`auth`, `billing`, `orchestrator`, `sniper`, `portfolio`,
`trades`, `notifications`, `admin`) are added incrementally, one roadmap phase
at a time — see `docs/ARCHITECTURE.md` at the repo root.
