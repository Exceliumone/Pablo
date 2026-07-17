import Image from "next/image";

export function Footer() {
  return (
    <footer className="border-t border-surface-border/10 py-10">
      <div className="container flex flex-col items-center justify-between gap-4 sm:flex-row">
        <div className="flex items-center gap-2.5">
          <Image src="/brand/emblem.webp" alt="PABLO" width={24} height={24} className="rounded-full" />
          <span className="font-display text-sm font-bold tracking-wide text-foreground">
            PABLO
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          Sniper &middot; Trader &middot; Builder. Le moteur de trading reste
          indépendant ; vous gardez le contrôle.
        </p>
        <p className="text-xs text-muted-foreground">
          &copy; {new Date().getFullYear()} PABLO
        </p>
      </div>
    </footer>
  );
}
