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
│   ├── engine-bridge/    Rust control surface around the engine:
│                         orchestrator + shared scanner + per-user
│                         executor binaries (Phase 3, done).
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
cargo run --bin engine-bridge   # orchestrator: HTTP API on :8090
# scanner and executor are spawned by the orchestrator, not run by hand
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
- **Phase 2 (subscription) — done.** SOL payments via `@solana/pay`
  (Solana Pay `reference` + `findReference`/`validateTransfer`, not a memo
  string), $PABLO holder auto-Premium with a periodic sweep so a balance
  drop is caught without the user opening the app, admin-editable
  `PlatformConfig` (role-gated, wallets in `ADMIN_WALLET_ADDRESSES`
  auto-promoted), and an 11-case unit-tested subscription state machine
  (ACTIVE/GRACE/EXPIRED). Solana RPC and the CoinGecko price API are both
  blocked by this sandbox's network policy, so the on-chain happy paths
  (a real confirmed payment, a real detected holder balance) couldn't be
  exercised end-to-end here — verified instead that they fail cleanly
  rather than crash or leak internal errors. Test the live paths before
  production.
- **Phase 3 (bridge to the engine) — done.** `engine-bridge` restructured
  into a library plus three binaries (`engine-bridge` orchestrator,
  `scanner`, `executor`), all built against the unmodified `engine` crate
  as a dependency — no file under `engine/` was touched. One shared
  scanner (single Yellowstone gRPC subscription, reuses the engine's own
  parsing functions) publishes detections onto a Redis Stream; one
  independent OS process per subscriber consumes it and calls the
  engine's real `execute_buy`/`SellingEngine` functions directly. The
  orchestrator spawns/kills/monitors those processes and self-heals its
  status view via a Redis pub/sub subscription to what each executor
  self-reports. `apps/api`'s new `bot` module and `/ws` gateway are the
  *only* thing that ever talks to the engine — through
  `packages/shared-types` DTOs mirrored by hand in `contract.rs` — so a
  future engine rewrite can swap underneath without touching the frontend
  or the API. Verified end-to-end against a real local Postgres/Redis:
  process spawn/stop/status, the Redis Stream fan-out, the pub/sub relay,
  and a real WebSocket client receiving live events with JWT auth
  enforced. **Not verifiable in this sandbox**: actual Yellowstone gRPC
  connectivity and actual on-chain trade execution, since Solana RPC/gRPC
  is blocked by network egress policy here — test both on Devnet before
  Mainnet.
- **Next: Phase 4 (trading dashboard)** — live sniper feed, portfolio,
  history, analytics.

See §14 of `docs/ARCHITECTURE.md` for the full roadmap.
