"use client";

import { useState } from "react";
import type { AdminUserListItemDto } from "@pablo/shared-types";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function SubscriptionsTable({
  users,
  actionPending,
  onGrant,
  onRevoke,
}: {
  users: AdminUserListItemDto[];
  actionPending: boolean;
  onGrant: (userId: string, days: number) => Promise<void>;
  onRevoke: (userId: string) => Promise<void>;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function grant(userId: string) {
    setPendingId(userId);
    try {
      await onGrant(userId, 30);
    } finally {
      setPendingId(null);
    }
  }

  async function revoke(userId: string) {
    setPendingId(userId);
    try {
      await onRevoke(userId);
    } finally {
      setPendingId(null);
    }
  }

  if (users.length === 0) {
    return (
      <div className="glass rounded-xl p-10 text-center text-sm text-muted-foreground">
        Aucun abonnement pour ce filtre.
      </div>
    );
  }

  return (
    <div className="glass overflow-x-auto rounded-xl">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-surface-border/10 text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-5 py-3 font-medium">Wallet</th>
            <th className="px-5 py-3 font-medium">Statut</th>
            <th className="px-5 py-3 font-medium">Source</th>
            <th className="px-5 py-3 font-medium">Fin de période</th>
            <th className="px-5 py-3 font-medium">Grâce jusqu&apos;au</th>
            <th className="px-5 py-3 font-medium" />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const isPending = pendingId === u.id && actionPending;
            const isAdminGrant = u.subscription.source === "ADMIN_GRANT";
            return (
              <tr key={u.id} className="border-b border-surface-border/10 last:border-0">
                <td className="text-tabular px-5 py-3 text-foreground">
                  {u.primaryWallet
                    ? `${u.primaryWallet.slice(0, 6)}…${u.primaryWallet.slice(-4)}`
                    : "—"}
                </td>
                <td className="px-5 py-3">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                      u.subscription.status === "ACTIVE" && "bg-success/10 text-success",
                      u.subscription.status === "GRACE" && "bg-warning/10 text-warning",
                      u.subscription.status === "EXPIRED" && "bg-white/5 text-muted-foreground",
                    )}
                  >
                    {u.subscription.status}
                  </span>
                </td>
                <td className="px-5 py-3 text-muted-foreground">{u.subscription.source ?? "—"}</td>
                <td className="text-tabular px-5 py-3 text-xs text-muted-foreground">
                  {u.subscription.currentPeriodEnd
                    ? new Date(u.subscription.currentPeriodEnd).toLocaleDateString("fr-FR")
                    : "—"}
                </td>
                <td className="text-tabular px-5 py-3 text-xs text-muted-foreground">
                  {u.subscription.graceUntil
                    ? new Date(u.subscription.graceUntil).toLocaleDateString("fr-FR")
                    : "—"}
                </td>
                <td className="px-5 py-3">
                  {isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-pablo-400" />
                  ) : isAdminGrant ? (
                    <Button size="sm" variant="glass" onClick={() => void revoke(u.id)}>
                      Révoquer
                    </Button>
                  ) : (
                    <Button size="sm" variant="glass" onClick={() => void grant(u.id)}>
                      Accorder (30j)
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
