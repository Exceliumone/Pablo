"use client";

import { useState } from "react";
import { Loader2, RefreshCcw } from "lucide-react";
import type { PositionDto } from "@pablo/shared-types";
import { Button } from "@/components/ui/button";
import { PositionsTable } from "@/components/portfolio/positions-table";
import { useAuth } from "@/components/providers/auth-provider";
import { usePortfolio } from "@/lib/use-portfolio";
import { apiFetch, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

// The sell itself happens asynchronously in the executor (or a one-shot
// process it spawns) after this call returns "accepted" — this just gives
// that a moment to land and event-persister.ts a moment to flip the
// Position row to CLOSED before re-fetching, so the table doesn't refresh
// too early and still show it as open.
const CLOSE_POSITION_SETTLE_MS = 4000;

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
  const { portfolio, loading, error, refresh } = usePortfolio(accessToken);
  const [closingPositionId, setClosingPositionId] = useState<string | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);

  async function handleClosePosition(position: PositionDto) {
    if (!accessToken || closingPositionId) return;
    const label = position.tokenSymbol ?? `${position.tokenMint.slice(0, 6)}…`;
    const confirmed = window.confirm(
      `Clôturer la position ${label} maintenant ? Le bot va vendre immédiatement 100% du solde on-chain, indépendamment du take-profit/stop-loss configuré.`,
    );
    if (!confirmed) return;

    setCloseError(null);
    setClosingPositionId(position.id);
    try {
      await apiFetch(`/portfolio/positions/${position.id}/close`, {
        method: "POST",
        accessToken,
      });
      await new Promise((resolve) => setTimeout(resolve, CLOSE_POSITION_SETTLE_MS));
      await refresh();
    } catch (err) {
      setCloseError(err instanceof ApiError ? err.message : "Échec de la clôture de la position.");
    } finally {
      setClosingPositionId(null);
    }
  }

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

          {closeError && (
            <div className="glass rounded-xl p-4 text-center text-sm text-danger">{closeError}</div>
          )}

          <PositionsTable
            positions={portfolio.positions}
            onClosePosition={handleClosePosition}
            closingPositionId={closingPositionId}
          />
        </>
      )}
    </div>
  );
}
