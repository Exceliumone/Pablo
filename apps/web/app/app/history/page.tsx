"use client";

import { Loader2, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TradesTable } from "@/components/history/trades-table";
import { useAuth } from "@/components/providers/auth-provider";
import { useTrades } from "@/lib/use-trades";
import { cn } from "@/lib/utils";

const FILTERS = [
  { value: "ALL", label: "Tout" },
  { value: "BUY", label: "Achats" },
  { value: "SELL", label: "Ventes" },
] as const;

export default function HistoryPage() {
  const { accessToken } = useAuth();
  const { trades, loading, loadingMore, error, hasMore, side, setSide, loadMore } =
    useTrades(accessToken);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-pablo-400">
          Historique
        </p>
        <h1 className="mt-3 text-balance font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
          Journal des transactions
        </h1>
      </div>

      <div className="flex justify-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setSide(f.value)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              side === f.value
                ? "bg-pablo-500/15 text-pablo-300"
                : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && trades.length === 0 && (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-pablo-400" />
        </div>
      )}

      {error && (
        <div className="glass flex flex-col items-center gap-3 rounded-xl p-7 text-center">
          <p className="text-sm text-danger">{error}</p>
          <Button variant="glass" size="sm" onClick={() => window.location.reload()}>
            <RefreshCcw className="h-3.5 w-3.5" />
            Réessayer
          </Button>
        </div>
      )}

      {!loading && trades.length > 0 && <TradesTable trades={trades} />}
      {!loading && trades.length === 0 && !error && <TradesTable trades={[]} />}

      {hasMore && (
        <div className="flex justify-center">
          <Button variant="glass" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Charger plus
          </Button>
        </div>
      )}
    </div>
  );
}
