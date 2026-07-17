"use client";

import { Loader2, RefreshCcw, ServerCrash } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/components/providers/auth-provider";
import { useAdminExecutors } from "@/lib/use-admin-executors";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<string, string> = {
  STOPPED: "Arrêté",
  STARTING: "Démarrage…",
  RUNNING: "En cours",
  STOPPING: "Arrêt…",
  ERROR: "Erreur",
};

export default function AdminExecutorsPage() {
  const { accessToken } = useAuth();
  const { data, loading, error, refresh } = useAdminExecutors(accessToken);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-pablo-400">
          Executors
        </p>
        <h1 className="mt-3 text-balance font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
          Monitoring des bots
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Vue en direct de l&apos;orchestrateur engine-bridge — un processus par abonné actif.
        </p>
      </div>

      {loading && !data && (
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

      {data && !data.reachable && (
        <div className="glass flex flex-col items-center gap-3 rounded-xl p-10 text-center">
          <div className="inline-flex rounded-full bg-warning/10 p-3 text-warning">
            <ServerCrash className="h-6 w-6" />
          </div>
          <h3 className="font-display text-lg font-bold text-foreground">
            Orchestrateur injoignable
          </h3>
          <p className="max-w-sm text-sm text-muted-foreground">
            engine-bridge ne répond pas — soit il n&apos;est pas démarré, soit
            ENGINE_BRIDGE_URL pointe au mauvais endroit.
          </p>
          <Button variant="glass" size="sm" onClick={() => void refresh()}>
            <RefreshCcw className="h-3.5 w-3.5" />
            Réessayer
          </Button>
        </div>
      )}

      {data && data.reachable && data.executors.length === 0 && (
        <div className="glass rounded-xl p-10 text-center text-sm text-muted-foreground">
          Aucun executor actif pour l&apos;instant.
        </div>
      )}

      {data && data.reachable && data.executors.length > 0 && (
        <div className="glass overflow-x-auto rounded-xl">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-surface-border/10 text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-3 font-medium">Utilisateur</th>
                <th className="px-5 py-3 font-medium">Statut</th>
                <th className="px-5 py-3 font-medium">PID</th>
                <th className="px-5 py-3 font-medium">Redémarrages</th>
                <th className="px-5 py-3 font-medium">Dernier événement</th>
                <th className="px-5 py-3 font-medium">Dernière erreur</th>
              </tr>
            </thead>
            <tbody>
              {data.executors.map((e) => (
                <tr key={e.userId} className="border-b border-surface-border/10 last:border-0">
                  <td className="text-tabular px-5 py-3 text-foreground">
                    {e.userId.slice(0, 10)}…
                  </td>
                  <td className="px-5 py-3">
                    <span
                      className={cn(
                        "flex w-fit items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                        e.status === "RUNNING" && "bg-success/10 text-success",
                        (e.status === "STARTING" || e.status === "STOPPING") &&
                          "bg-pablo-500/15 text-pablo-300",
                        e.status === "STOPPED" && "bg-white/5 text-muted-foreground",
                        e.status === "ERROR" && "bg-danger/10 text-danger",
                      )}
                    >
                      {STATUS_LABEL[e.status] ?? e.status}
                    </span>
                  </td>
                  <td className="text-tabular px-5 py-3 text-muted-foreground">{e.pid ?? "—"}</td>
                  <td className="text-tabular px-5 py-3 text-muted-foreground">{e.restartCount}</td>
                  <td className="text-tabular px-5 py-3 text-xs text-muted-foreground">
                    {e.lastEventAt ? new Date(e.lastEventAt).toLocaleTimeString("fr-FR") : "—"}
                  </td>
                  <td className="max-w-xs truncate px-5 py-3 text-xs text-danger">
                    {e.lastError ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
