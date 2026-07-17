// Phase 0 placeholder — proves the PABLO design tokens (tailwind.config.ts,
// globals.css) render correctly. The real landing page (hero, features,
// roadmap, FAQ, stats) is built in Phase 1, see docs/ARCHITECTURE.md.
export default function Home() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-grid-fade bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,black,transparent)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 h-[480px] w-[480px] -translate-x-1/2 rounded-full bg-pablo-600/30 blur-[120px]"
      />

      <div className="glass relative z-10 flex flex-col items-center gap-6 rounded-lg px-10 py-12 text-center shadow-glow">
        <span className="rounded-full border border-pablo-500/30 bg-pablo-500/10 px-3 py-1 text-xs uppercase tracking-[0.2em] text-pablo-300">
          Building in public
        </span>
        <h1 className="font-display text-5xl font-bold tracking-tight text-foreground">
          PABLO
        </h1>
        <p className="max-w-sm text-sm text-muted-foreground">
          Sniper &middot; Trader &middot; Builder. The terminal is under
          construction — Premium access, live for $PABLO holders and SOL
          subscribers alike.
        </p>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="h-1.5 w-1.5 animate-pulse-glow rounded-full bg-success" />
          Phase 0 — foundations
        </div>
      </div>
    </main>
  );
}
