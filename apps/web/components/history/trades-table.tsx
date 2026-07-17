"use client";

import type { TradeDto } from "@pablo/shared-types";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<TradeDto["status"], string> = {
  PENDING: "En attente",
  CONFIRMED: "Confirmée",
  FAILED: "Échouée",
};

export function TradesTable({ trades }: { trades: TradeDto[] }) {
  if (trades.length === 0) {
    return (
      <div className="glass rounded-xl p-10 text-center text-sm text-muted-foreground">
        Aucune transaction pour l&apos;instant.
      </div>
    );
  }

  return (
    <div className="glass overflow-x-auto rounded-xl">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-surface-border/10 text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-5 py-3 font-medium">Côté</th>
            <th className="px-5 py-3 font-medium">Token</th>
            <th className="px-5 py-3 font-medium">Protocole</th>
            <th className="px-5 py-3 font-medium">Prix</th>
            <th className="px-5 py-3 font-medium">Montant</th>
            <th className="px-5 py-3 font-medium">Statut</th>
            <th className="px-5 py-3 font-medium">Signature</th>
            <th className="px-5 py-3 font-medium">Date</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id} className="border-b border-surface-border/10 last:border-0">
              <td className="px-5 py-3">
                <span
                  className={cn(
                    "flex w-fit items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                    t.side === "BUY" ? "bg-success/10 text-success" : "bg-danger/10 text-danger",
                  )}
                >
                  {t.side === "BUY" ? (
                    <ArrowUpRight className="h-3 w-3" />
                  ) : (
                    <ArrowDownRight className="h-3 w-3" />
                  )}
                  {t.side === "BUY" ? "Achat" : "Vente"}
                </span>
              </td>
              <td className="text-tabular px-5 py-3 text-foreground">
                {t.tokenSymbol ?? `${t.tokenMint.slice(0, 6)}…${t.tokenMint.slice(-4)}`}
              </td>
              <td className="px-5 py-3 text-muted-foreground">{t.protocol}</td>
              <td className="text-tabular px-5 py-3 text-muted-foreground">
                {t.priceSol.toFixed(8)}
              </td>
              <td className="text-tabular px-5 py-3 text-muted-foreground">
                {t.amountSol.toFixed(4)} SOL
              </td>
              <td className="px-5 py-3">
                <span
                  className={cn(
                    "text-xs",
                    t.status === "CONFIRMED" && "text-success",
                    t.status === "PENDING" && "text-muted-foreground",
                    t.status === "FAILED" && "text-danger",
                  )}
                >
                  {STATUS_LABEL[t.status]}
                </span>
              </td>
              <td className="px-5 py-3 text-xs text-muted-foreground">
                {t.txSignature ? `${t.txSignature.slice(0, 6)}…` : "—"}
              </td>
              <td className="text-tabular px-5 py-3 text-xs text-muted-foreground">
                {new Date(t.createdAt).toLocaleString("fr-FR")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
