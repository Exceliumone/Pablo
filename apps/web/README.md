# @pablo/web

Next.js 15 (App Router) frontend — landing page + subscriber dashboard + admin.

## Shipped so far

**Phase 0 — design tokens.** `tailwind.config.ts` / `app/globals.css`: dark
ground, violet-neon accent (`pablo-500/600`), glassmorphism surface
(`.glass`), semantic success/danger colors kept separate from the accent.
Display face is `Big Shoulders` (condensed, heavy — echoes the wordmark),
data/prices use `JetBrains Mono` with tabular numerals (`app/fonts.ts`).

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

## Route map (built incrementally, one phase at a time)

```
app/
  page.tsx              Phase 1 — landing page (done)
  (dashboard)/           Phase 4 — sniper, portfolio, history, wallet,
                          analytics, settings, support
  (admin)/                Phase 5 — admin panel
```

## Local dev

```bash
cp .env.example .env   # NEXT_PUBLIC_API_URL, defaults to localhost:4000
pnpm --filter @pablo/web dev
```

Needs `@pablo/api` running (see `apps/api/README.md`) for the wallet
connect flow to do anything beyond render.
