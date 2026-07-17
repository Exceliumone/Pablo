"use client";

import { useState } from "react";
import type { AdminUserListItemDto, UserRole, UserStatus } from "@pablo/shared-types";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const ROLE_OPTIONS: UserRole[] = ["SUBSCRIBER", "SUPPORT", "ADMIN"];
const STATUS_OPTIONS: UserStatus[] = ["ACTIVE", "SUSPENDED", "BANNED"];

function StatusBadge({ status }: { status: UserStatus }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        status === "ACTIVE" && "bg-success/10 text-success",
        status === "SUSPENDED" && "bg-warning/10 text-warning",
        status === "BANNED" && "bg-danger/10 text-danger",
      )}
    >
      {status}
    </span>
  );
}

export function UsersTable({
  users,
  currentUserId,
  onUpdate,
}: {
  users: AdminUserListItemDto[];
  currentUserId: string | undefined;
  onUpdate: (userId: string, patch: { role?: UserRole; status?: UserStatus }) => Promise<void>;
}) {
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function apply(userId: string, patch: { role?: UserRole; status?: UserStatus }) {
    setPendingId(userId);
    try {
      await onUpdate(userId, patch);
    } finally {
      setPendingId(null);
    }
  }

  if (users.length === 0) {
    return (
      <div className="glass rounded-xl p-10 text-center text-sm text-muted-foreground">
        Aucun utilisateur.
      </div>
    );
  }

  return (
    <div className="glass overflow-x-auto rounded-xl">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-surface-border/10 text-xs uppercase tracking-wide text-muted-foreground">
            <th className="px-5 py-3 font-medium">Wallet</th>
            <th className="px-5 py-3 font-medium">Rôle</th>
            <th className="px-5 py-3 font-medium">Statut</th>
            <th className="px-5 py-3 font-medium">Abonnement</th>
            <th className="px-5 py-3 font-medium">Inscrit</th>
            <th className="px-5 py-3 font-medium" />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const isSelf = u.id === currentUserId;
            const isPending = pendingId === u.id;
            return (
              <tr key={u.id} className="border-b border-surface-border/10 last:border-0">
                <td className="text-tabular px-5 py-3 text-foreground">
                  {u.primaryWallet
                    ? `${u.primaryWallet.slice(0, 6)}…${u.primaryWallet.slice(-4)}`
                    : "—"}
                  {u.walletCount > 1 && (
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      +{u.walletCount - 1}
                    </span>
                  )}
                </td>
                <td className="px-5 py-3">
                  <select
                    className="rounded-md border border-surface-border/20 bg-white/[0.03] px-2 py-1 text-xs text-foreground disabled:opacity-50"
                    value={u.role}
                    disabled={isSelf || isPending}
                    onChange={(e) => void apply(u.id, { role: e.target.value as UserRole })}
                  >
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={u.status} />
                    <select
                      className="rounded-md border border-surface-border/20 bg-white/[0.03] px-2 py-1 text-xs text-foreground disabled:opacity-50"
                      value={u.status}
                      disabled={isPending}
                      onChange={(e) => void apply(u.id, { status: e.target.value as UserStatus })}
                    >
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </div>
                </td>
                <td className="px-5 py-3 text-muted-foreground">
                  {u.subscription.tier === "PREMIUM" ? (
                    <span className="text-pablo-300">
                      Premium · {u.subscription.source ?? "—"}
                    </span>
                  ) : (
                    "Free"
                  )}
                </td>
                <td className="text-tabular px-5 py-3 text-xs text-muted-foreground">
                  {new Date(u.createdAt).toLocaleDateString("fr-FR")}
                </td>
                <td className="px-5 py-3">{isPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-pablo-400" />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
