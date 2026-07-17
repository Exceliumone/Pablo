"use client";

import { Loader2, RefreshCcw } from "lucide-react";
import type { SubscriptionStatus } from "@pablo/shared-types";
import { Button } from "@/components/ui/button";
import { SubscriptionsTable } from "@/components/admin/subscriptions-table";
import { useAuth } from "@/components/providers/auth-provider";
import { useAdminSubscriptions } from "@/lib/use-admin-subscriptions";
import { cn } from "@/lib/utils";

const FILTERS: { value: SubscriptionStatus | "ALL"; label: string }[] = [
  { value: "ALL", label: "Tout" },
  { value: "ACTIVE", label: "Actifs" },
  { value: "GRACE", label: "Grâce" },
  { value: "EXPIRED", label: "Expirés" },
];

export default function AdminSubscriptionsPage() {
  const { accessToken } = useAuth();
  const {
    users,
    loading,
    loadingMore,
    error,
    hasMore,
    loadMore,
    status,
    setStatus,
    grant,
    revoke,
    actionPending,
  } = useAdminSubscriptions(accessToken);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-pablo-400">
          Abonnements
        </p>
        <h1 className="mt-3 text-balance font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
          Licences Premium
        </h1>
      </div>

      <div className="flex justify-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatus(f.value)}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              status === f.value
                ? "bg-pablo-500/15 text-pablo-300"
                : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && users.length === 0 && (
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

      {!loading && (
        <SubscriptionsTable
          users={users}
          actionPending={actionPending}
          onGrant={grant}
          onRevoke={revoke}
        />
      )}

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
