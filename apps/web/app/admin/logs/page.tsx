"use client";

import { Loader2, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/components/providers/auth-provider";
import { useAdminLogs } from "@/lib/use-admin-logs";
import { cn } from "@/lib/utils";

export default function AdminLogsPage() {
  const { accessToken } = useAuth();
  const { logs, loading, loadingMore, error, hasMore, loadMore } = useAdminLogs(accessToken);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-pablo-400">Logs</p>
        <h1 className="mt-3 text-balance font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
          Journal d&apos;audit
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Chaque changement de rôle, de statut, ou d&apos;abonnement effectué depuis cette console.
        </p>
      </div>

      {loading && logs.length === 0 && (
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

      {!loading && logs.length === 0 && !error && (
        <div className="glass rounded-xl p-10 text-center text-sm text-muted-foreground">
          Aucune action enregistrée pour l&apos;instant.
        </div>
      )}

      {!loading && logs.length > 0 && (
        <div className="glass flex flex-col rounded-xl p-2">
          {logs.map((log) => (
            <div
              key={log.id}
              className="flex flex-col gap-1 border-b border-surface-border/10 px-5 py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                    log.actorType === "ADMIN" ? "bg-pablo-500/15 text-pablo-300" : "bg-white/5 text-muted-foreground",
                  )}
                >
                  {log.actorType}
                </span>
                <span className="text-tabular text-sm font-medium text-foreground">{log.action}</span>
                {log.meta && (
                  <span className="text-tabular hidden text-xs text-muted-foreground md:inline">
                    {JSON.stringify(log.meta)}
                  </span>
                )}
              </div>
              <span className="text-tabular text-xs text-muted-foreground">
                {new Date(log.createdAt).toLocaleString("fr-FR")}
              </span>
            </div>
          ))}
        </div>
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
