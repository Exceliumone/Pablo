# PABLO

Web3 SaaS platform around the $PABLO memecoin: a subscriber-facing sniper
terminal built on top of an existing, unmodified Rust trading engine.

**Start here:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — the full
architecture analysis, the two validated infrastructure decisions (shared
scanner + per-user executors; custodial trading wallet, generated or
imported), the Prisma schema, the API design, and the phased roadmap.

## Layout

```
pablo/
├── engine/              The existing Rust sniper/copy-trading engine.
│                         Untouched — see engine/UPSTREAM.md.
├── apps/
│   ├── engine-bridge/    Rust/Axum control surface around the engine
│                         (scanner + per-user executor, Phase 3).
│   ├── api/              Fastify backend — auth, billing, orchestration,
│                         Prisma schema.
│   └── web/               Next.js 15 frontend — landing, dashboard, admin.
├── packages/
│   └── shared-types/      Zod DTOs shared between web and api.
├── infra/                 docker-compose.yml (Postgres, Redis) for local dev.
└── docs/
    └── ARCHITECTURE.md
```

## Local dev

Node/TS side:

```bash
pnpm install
docker compose -f infra/docker-compose.yml up -d postgres redis
cp apps/api/.env.example apps/api/.env   # then fill in real values
pnpm --filter @pablo/api prisma:generate
pnpm dev      # runs web + api via turbo
```

Rust side:

```bash
cargo check --workspace
cargo run --bin engine-bridge   # health/version skeleton today
```

## Status

- **Phase 0 (foundations) — done.** Monorepo tooling, the engine imported
  verbatim, `engine-bridge`/`api`/`web` skeletons all build and boot, CI
  wired.
- **Phase 1 (identity & landing) — done.** Sign-In-With-Solana auth
  end-to-end (nonce → signature → JWT + rotating refresh session, verified
  against a real Postgres/Redis), wallet-adapter wired into the frontend,
  and the full premium landing page (hero, features, roadmap, FAQ, stats,
  launch CTA) with the PABLO brand assets.
- **Next: Phase 2 (subscription)** — SOL payment verification, $PABLO
  holder auto-Premium, admin-editable `PlatformConfig`.

See §14 of `docs/ARCHITECTURE.md` for the full roadmap.
