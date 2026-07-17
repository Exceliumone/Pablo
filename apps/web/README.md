# @pablo/web

Next.js 15 (App Router) frontend — landing page + subscriber dashboard + admin.

## Phase 0 scope

- App boots, renders a single placeholder route proving the PABLO design
  tokens (`tailwind.config.ts`, `app/globals.css`): dark ground, violet-neon
  accent (`pablo-500/600`), glassmorphism surface (`.glass`), semantic
  success/danger colors kept separate from the accent.
- `components.json` is wired for the shadcn/ui CLI so Phase 1 can start
  pulling components (`pnpm dlx shadcn add button card ...`) against the
  right tokens immediately.
- Brand imagery (logo, mascot art) is intentionally not yet committed here —
  final exported assets get added once confirmed.

## Route map (built incrementally, one phase at a time)

```
app/
  (marketing)/        Phase 1 — landing page
  (dashboard)/         Phase 4 — sniper, portfolio, history, wallet,
                        analytics, settings, support
  (admin)/              Phase 5 — admin panel
```

## Local dev

```bash
pnpm --filter @pablo/web dev
```
