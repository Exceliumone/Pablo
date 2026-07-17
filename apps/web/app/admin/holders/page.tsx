"use client";

import { Loader2, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HoldersTable } from "@/components/admin/holders-table";
import { useAuth } from "@/components/providers/auth-provider";
import { useAdminHolders } from "@/lib/use-admin-holders";

export default function AdminHoldersPage() {
  const { accessToken } = useAuth();
  const { holders, loading, loadingMore, error, hasMore, loadMore } = useAdminHolders(accessToken);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-pablo-400">Holders</p>
        <h1 className="mt-3 text-balance font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
          Détenteurs de $PABLO
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Dernier solde observé par le sweep périodique — pas une vérification en direct à chaque
          chargement de page.
        </p>
      </div>

      {loading && holders.length === 0 && (
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

      {!loading && <HoldersTable holders={holders} />}

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
