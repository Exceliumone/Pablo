"use client";

import { Loader2, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/components/providers/auth-provider";
import { useAdminStats } from "@/lib/use-admin-stats";
import { cn } from "@/lib/utils";

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "success" | "danger";
}) {
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

export default function AdminStatsPage() {
  const { accessToken } = useAuth();
  const { stats, loading, error } = useAdminStats(accessToken);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-pablo-400">
          Console admin
        </p>
        <h1 className="mt-3 text-balance font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
          Vue d&apos;ensemble
        </h1>
      </div>

      {loading && !stats && (
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

      {stats && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <StatCard label="Utilisateurs" value={String(stats.totalUsers)} />
            <StatCard label="Nouveaux (7j)" value={`+${stats.newUsersLast7d}`} tone="success" />
            <StatCard label="Abonnements actifs" value={String(stats.activeSubscriptions)} />
            <StatCard
              label="Bots en cours"
              value={stats.botsRunning !== null ? String(stats.botsRunning) : "—"}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <StatCard label="Premium — paiement SOL" value={String(stats.premiumViaPayment)} />
            <StatCard label="Premium — holders $PABLO" value={String(stats.premiumViaHolder)} />
            <StatCard label="Premium — accordé (admin)" value={String(stats.premiumViaAdminGrant)} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard label="Transactions totales" value={String(stats.totalTrades)} />
            <StatCard
              label="Volume d'achat total"
              value={`${stats.totalBuyVolumeSol.toFixed(3)} SOL`}
            />
          </div>

          {stats.botsRunning === null && (
            <p className="text-center text-xs text-muted-foreground">
              L&apos;orchestrateur (engine-bridge) n&apos;est pas joignable — le nombre de bots en
              cours n&apos;a pas pu être récupéré.
            </p>
          )}
        </>
      )}
    </div>
  );
}
