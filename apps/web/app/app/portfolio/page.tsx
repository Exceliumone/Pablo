"use client";

import { Loader2, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PositionsTable } from "@/components/portfolio/positions-table";
import { useAuth } from "@/components/providers/auth-provider";
import { usePortfolio } from "@/lib/use-portfolio";
import { cn } from "@/lib/utils";

function StatCard({ label, value, tone }: { label: string; value: string; tone?: "success" | "danger" }) {
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

export default function PortfolioPage() {
  const { accessToken } = useAuth();
  const { portfolio, loading, error } = usePortfolio(accessToken);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-pablo-400">
          Portfolio
        </p>
        <h1 className="mt-3 text-balance font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
          Vos positions
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          PnL réalisé uniquement — pas de flux de prix en direct pour l&apos;instant, donc pas de
          PnL non réalisé affiché.
        </p>
      </div>

      {loading && !portfolio && (
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

      {portfolio && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Positions ouvertes" value={String(portfolio.summary.openCount)} />
            <StatCard
              label="Coût engagé"
              value={`${portfolio.summary.openCostBasisSol.toFixed(3)} SOL`}
            />
            <StatCard label="Positions clôturées" value={String(portfolio.summary.closedCount)} />
            <StatCard
              label="PnL réalisé total"
              value={`${portfolio.summary.totalRealizedPnlSol >= 0 ? "+" : ""}${portfolio.summary.totalRealizedPnlSol.toFixed(4)} SOL`}
              tone={portfolio.summary.totalRealizedPnlSol >= 0 ? "success" : "danger"}
            />
          </div>

          <PositionsTable positions={portfolio.positions} />
        </>
      )}
    </div>
  );
}
