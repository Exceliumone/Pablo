"use client";

import { Loader2, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PnlChart } from "@/components/analytics/pnl-chart";
import { useAuth } from "@/components/providers/auth-provider";
import { useAnalytics } from "@/lib/use-analytics";
import { cn } from "@/lib/utils";

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "success" | "danger";
}) {
  return (
    <div className="glass rounded-xl p-5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "text-tabular mt-1.5 font-display text-2xl font-bold text-foreground",
          tone === "success" && "text-success",
          tone === "danger" && "text-danger",
        )}
      >
        {value}
      </p>
    </div>
  );
}

export default function AnalyticsPage() {
  const { accessToken } = useAuth();
  const { summary, loading, error } = useAnalytics(accessToken);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-pablo-400">
          Analytics
        </p>
        <h1 className="mt-3 text-balance font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
          Performance du bot
        </h1>
      </div>

      {loading && !summary && (
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

      {summary && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Transactions" value={String(summary.totalTrades)} />
            <StatCard
              label="Taux de réussite"
              value={summary.winRatePct !== null ? `${summary.winRatePct.toFixed(0)}%` : "—"}
            />
            <StatCard
              label="PnL réalisé total"
              value={`${summary.totalRealizedPnlSol >= 0 ? "+" : ""}${summary.totalRealizedPnlSol.toFixed(4)} SOL`}
              tone={summary.totalRealizedPnlSol >= 0 ? "success" : "danger"}
            />
            <StatCard
              label="Durée moyenne de détention"
              value={
                summary.avgHoldTimeMinutes !== null
                  ? summary.avgHoldTimeMinutes < 60
                    ? `${summary.avgHoldTimeMinutes.toFixed(0)} min`
                    : `${(summary.avgHoldTimeMinutes / 60).toFixed(1)} h`
                  : "—"
              }
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Achats / ventes" value={`${summary.buyCount} / ${summary.sellCount}`} />
            <StatCard
              label="Meilleur trade"
              value={summary.bestTradePnlSol !== null ? `+${summary.bestTradePnlSol.toFixed(4)} SOL` : "—"}
              tone="success"
            />
            <StatCard
              label="Pire trade"
              value={summary.worstTradePnlSol !== null ? `${summary.worstTradePnlSol.toFixed(4)} SOL` : "—"}
              tone="danger"
            />
          </div>

          <PnlChart data={summary.pnlByDay} />
        </>
      )}
    </div>
  );
}
