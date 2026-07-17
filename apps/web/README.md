# @pablo/web

Next.js 15 (App Router) frontend — landing page + subscriber dashboard + admin.

## Shipped so far

**Phase 0 — design tokens.** `tailwind.config.ts` / `app/globals.css`: dark
ground, violet-neon accent (`pablo-500/600`), glassmorphism surface
(`.glass`), semantic success/danger colors kept separate from the accent.
Display face is `Big Shoulders` (condensed, heavy — echoes the wordmark),
data/prices use `JetBrains Mono` with tabular numerals (`app/fonts.ts`,
self-hosted via `next/font/local` from `assets/fonts/` — not
`next/font/google`, so the build never depends on live network access to
fonts.gstatic.com).

**Phase 1 — identity & landing.**
- `components/providers/solana-wallet-provider.tsx` +
  `components/providers/auth-provider.tsx`: wallet connection
  (Phantom/Solflare explicit, everything else auto-detected via the Wallet
  Standard) wired to the backend's Sign-In-With-Solana flow — connect →
  sign a nonce → session restored silently via httpOnly refresh cookie on
  return visits.
- `components/wallet/connect-button.tsx`: custom-styled wallet picker (not
  the stock `@solana/wallet-adapter-react-ui` modal — its generic chrome
  doesn't carry the PABLO treatment).
- `components/marketing/*`: the full landing page (hero, presentation,
  features, roadmap, FAQ, stats, launch CTA), assembled in `app/page.tsx`.
  Brand imagery lives in `public/brand/` (pre-optimized to WebP — see the
  optimization note in `next.config.ts` re: `sharp`).

**Phase 2 — subscription.**
- `app/subscribe/page.tsx`: gated (shows a connect prompt if not
  authenticated), live status via `lib/use-subscription.ts`
  (`GET /billing/subscription` always reconciles server-side, so re-fetching
  *is* the refresh — no separate refresh endpoint).
- `components/subscribe/payment-panel.tsx`: creates a payment intent, shows
  a Solana Pay QR (`@solana/pay`'s `createQR`) and a "pay with the connected
  wallet" button (`createTransfer` + wallet-adapter's `sendTransaction`),
  then polls for confirmation.
- `components/subscribe/holder-panel.tsx`: $PABLO balance vs. the
  admin-configured threshold, with a progress bar.
- "Launch App" everywhere now routes to `/subscribe` instead of anchor-
  scrolling to the landing page's CTA section.

**Phase 3 — bot terminal.**
- `app/app/page.tsx`: the Sniper tab — start/stop plus the live event feed.
- `lib/use-bot.ts`: status + start/stop against `/bot/*`.
- `lib/use-bot-events.ts`: opens `GET /ws?token=`, exponential-backoff
  reconnect (capped at 15s) on drop.
- `components/bot/`: `bot-control-panel.tsx` (start/stop, pid, WS
  connection indicator, restart count, last error),
  `bot-settings-form.tsx` (amount/TP/SL/trailing/slippage/priority-fee/
  copy-trading targets), `bot-event-feed.tsx` (live color-coded
  trade/opportunity/error/status rows).
- "Launch App" / the landing CTA now route to `/app` once authenticated
  (still `/subscribe` mid-way through the connect flow).

**Phase 4 — trading dashboard.**
- `app/app/layout.tsx`: auth- and subscription-gating moved here, once,
  out of the individual pages — everything under `app/app/*` can assume
  an authenticated, Premium user. `components/dashboard/dashboard-shell.tsx`
  is the six-tab shell (Sniper, Portfolio, Historique, Analytics, Wallet,
  Réglages) all of them share.
- `app/app/settings/page.tsx`: the settings form, moved out of the Sniper
  tab into its own page. Uses the new `lib/use-bot-settings.ts` — split
  out from `use-bot.ts` specifically so an unreachable `engine-bridge`
  orchestrator (which only `/bot/status` needs) can never blank out the
  settings form, which only needs `/bot/settings`. That coupling was a
  real bug caught via live testing (screenshotting the two pages side by
  side with the orchestrator deliberately not running), not a
  hypothetical one.
- `app/app/portfolio/page.tsx` + `components/portfolio/positions-table.tsx`:
  open/closed positions and a realized-PnL summary from `lib/use-portfolio.ts`.
- `app/app/history/page.tsx` + `components/history/trades-table.tsx`:
  cursor-paginated trade log with a buy/sell filter, via `lib/use-trades.ts`.
- `app/app/analytics/page.tsx` + `components/analytics/pnl-chart.tsx`: win
  rate, best/worst trade, and a 14-day realized-PnL bar chart — a plain
  flex/CSS bar chart with a zero baseline and a hover readout, not a
  charting library dependency, since one signed series per day doesn't
  need one.
- `app/app/wallet/page.tsx` + `components/wallet/{deposit-panel,withdraw-form}.tsx`:
  deposit QR/address (`@solana/pay`'s `createQR` again, reused from the
  Phase 2 payment panel) and a guarded withdraw form with an explicit
  confirm step before it calls `POST /wallet/withdraw`.

## Route map (built incrementally, one phase at a time)

```
app/
  page.tsx                 Phase 1 — landing page (done)
  subscribe/page.tsx       Phase 2 — subscription status + payment (done)
  app/layout.tsx           Phase 4 — auth/subscription gate + dashboard shell (done)
  app/page.tsx             Phase 3 — sniper tab: start/stop + live feed (done)
  app/portfolio/page.tsx   Phase 4 — open/closed positions (done)
  app/history/page.tsx     Phase 4 — paginated trade log (done)
  app/analytics/page.tsx   Phase 4 — win rate, PnL chart (done)
  app/wallet/page.tsx      Phase 4 — deposit/withdraw (done)
  app/settings/page.tsx    Phase 4 — bot settings form (done)
  (admin)/                 Phase 5 — admin panel
```

## Local dev

```bash
cp .env.example .env   # NEXT_PUBLIC_API_URL, defaults to localhost:4000
pnpm --filter @pablo/web dev
```

Needs `@pablo/api` running (see `apps/api/README.md`) for the wallet
connect flow to do anything beyond render.
