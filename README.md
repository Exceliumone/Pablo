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
- **Phase 4 (trading dashboard) — done.** The single-page terminal split
  into a six-tab dashboard (Sniper, Portfolio, Historique, Analytics,
  Wallet, Réglages) sharing one auth/subscription gate. A new process-wide
  Redis subscriber (`apps/api/src/jobs/event-persister.ts`) turns the
  executor's `trade`/`error` events into durable `Trade` and `Position`
  rows — average-cost accounting on repeat buys, full-close PnL on sell,
  serialized processing so a same-tick buy-then-sell can't race the
  database. `GET /portfolio`, `GET /trades` (cursor-paginated), and
  `GET /analytics/summary` (win rate, best/worst trade, a 14-day realized
  PnL chart) all read from that ledger. `GET /wallet` and
  `POST /wallet/withdraw` round out the custodial trading wallet — deposit
  QR/address, live SOL/$PABLO balance (best-effort, `null` where RPC is
  unavailable), and a guarded SOL transfer out (blocked while the bot is
  running). Verified end-to-end against a real local Postgres/Redis by
  injecting real executor events and confirming the full pipeline —
  including catching and fixing a genuine race condition where an
  unserialized event handler let a SELL's "find the open position" query
  run before the matching BUY's insert had committed. **Not verifiable in
  this sandbox**: live SOL/$PABLO balances and the withdraw transaction
  itself, since Solana RPC is blocked by network egress policy here — the
  code fails cleanly (a `null` balance, a sanitized 500) rather than
  crashing; test the live paths on Devnet before Mainnet.
- **Phase 5 (landing page premium) — done.** Scroll-reveal animations
  (`framer-motion`'s `whileInView`) added to every marketing section that
  didn't already have one (Presentation, Stats, FAQ, Conviction, Roadmap,
  the launch CTA), an animated mobile nav collapse, and a spring-animated
  active-tab indicator in the dashboard shell. The real work was a mobile
  pass across all seven pages (landing + six dashboard tabs) using a
  headless-browser session authenticated through the actual SIWS + cookie
  flow, screenshotted at 375px and audited for horizontal overflow
  programmatically (not by eyeballing) — that caught two genuine bugs, not
  hypothetical ones: the wallet address's `truncate` never engaged because
  neither the flex row nor the CSS Grid item it sat in had `min-w-0` (a
  classic "flex/grid items don't shrink below content size by default"
  trap), so a 44-character base58 address was blowing the wallet page out
  to 462px on a 375px viewport; and the dashboard's tab strip scrolls
  horizontally but gave no visual hint that Wallet and Réglages existed
  past the fold, fixed with a permanent edge-fade mask. Both fixed and
  reverified with a clean re-run (fresh login, single navigation, no stale
  session state) rather than assumed fixed.
- **Next: Phase 6 (admin console)** — users, holders, licenses, stats,
  logs, executor monitoring.

See §14 of `docs/ARCHITECTURE.md` for the full roadmap.
