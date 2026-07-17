"use client";

import type { PositionDto } from "@pablo/shared-types";
import { cn } from "@/lib/utils";

function formatSol(n: number, digits = 4): string {
  return n.toFixed(digits);
}

export function PositionsTable({ positions }: { positions: PositionDto[] }) {
  if (positions.length === 0) {
    return (
      <div className="glass rounded-xl p-10 text-center text-sm text-muted-foreground">
        Aucune position pour l&apos;instant — elles apparaîtront ici dès le premier achat du bot.
      </div>
    );
  }

  return (
    <div className="glass overflow-x-auto rounded-xl">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-surface-border/10 text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-5 py-3 font-medium">Token</th>
            <th className="px-5 py-3 font-medium">Statut</th>
            <th className="px-5 py-3 font-medium">Prix d&apos;entrée</th>
            <th className="px-5 py-3 font-medium">Quantité</th>
            <th className="px-5 py-3 font-medium">Coût (SOL)</th>
            <th className="px-5 py-3 font-medium">PnL réalisé</th>
            <th className="px-5 py-3 font-medium">Ouverte</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p.id} className="border-b border-surface-border/10 last:border-0">
              <td className="text-tabular px-5 py-3 text-foreground">
                {p.tokenSymbol ?? `${p.tokenMint.slice(0, 6)}…${p.tokenMint.slice(-4)}`}
              </td>
              <td className="px-5 py-3">
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                    p.status === "OPEN" ? "bg-pablo-500/15 text-pablo-300" : "bg-white/5 text-muted-foreground",
                  )}
                >
                  {p.status === "OPEN" ? "Ouverte" : "Clôturée"}
                </span>
              </td>
              <td className="text-tabular px-5 py-3 text-muted-foreground">
                {formatSol(p.entryPriceSol, 8)}
              </td>
              <td className="text-tabular px-5 py-3 text-muted-foreground">
                {p.currentAmount.toLocaleString("fr-FR", { maximumFractionDigits: 2 })}
              </td>
              <td className="text-tabular px-5 py-3 text-muted-foreground">
                {formatSol(p.costBasisSol)}
              </td>
              <td
                className={cn(
                  "text-tabular px-5 py-3 font-medium",
                  p.status === "CLOSED"
                    ? p.realizedPnlSol >= 0
                      ? "text-success"
                      : "text-danger"
                    : "text-muted-foreground",
                )}
              >
                {p.status === "CLOSED" ? `${p.realizedPnlSol >= 0 ? "+" : ""}${formatSol(p.realizedPnlSol)}` : "—"}
              </td>
              <td className="text-tabular px-5 py-3 text-xs text-muted-foreground">
                {new Date(p.openedAt).toLocaleDateString("fr-FR")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
