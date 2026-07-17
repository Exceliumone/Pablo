"use client";

import type { AdminHolderDto } from "@pablo/shared-types";
import { cn } from "@/lib/utils";

export function HoldersTable({ holders }: { holders: AdminHolderDto[] }) {
  if (holders.length === 0) {
    return (
      <div className="glass rounded-xl p-10 text-center text-sm text-muted-foreground">
        Aucun wallet lié pour l&apos;instant.
      </div>
    );
  }

  return (
    <div className="glass overflow-x-auto rounded-xl">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-surface-border/10 text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-5 py-3 font-medium">Wallet</th>
            <th className="px-5 py-3 font-medium">Solde $PABLO</th>
            <th className="px-5 py-3 font-medium">Seuil atteint</th>
            <th className="px-5 py-3 font-medium">Dernier contrôle</th>
          </tr>
        </thead>
        <tbody>
          {holders.map((h) => (
            <tr key={h.userId} className="border-b border-surface-border/10 last:border-0">
              <td className="text-tabular px-5 py-3 text-foreground">
                {h.primaryWallet ? `${h.primaryWallet.slice(0, 6)}…${h.primaryWallet.slice(-4)}` : "—"}
              </td>
              <td className="text-tabular px-5 py-3 text-muted-foreground">
                {h.balanceHuman ?? (h.balanceRaw ? `${h.balanceRaw} (brut)` : "—")}
              </td>
              <td className="px-5 py-3">
                {h.meetsThreshold === null ? (
                  <span className="text-xs text-muted-foreground">Inconnu</span>
                ) : (
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                      h.meetsThreshold ? "bg-success/10 text-success" : "bg-white/5 text-muted-foreground",
                    )}
                  >
                    {h.meetsThreshold ? "Oui" : "Non"}
                  </span>
                )}
              </td>
              <td className="text-tabular px-5 py-3 text-xs text-muted-foreground">
                {h.checkedAt ? new Date(h.checkedAt).toLocaleString("fr-FR") : "Jamais vérifié"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
