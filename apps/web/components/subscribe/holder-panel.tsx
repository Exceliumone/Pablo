import type { SubscriptionViewDto } from "@pablo/shared-types";
import { Coins } from "lucide-react";
import { cn } from "@/lib/utils";

export function HolderPanel({ holder }: { holder: SubscriptionViewDto["holder"] }) {
  const balance = Number(holder.balanceHuman);
  const required = Number(holder.requiredHuman);
  const pct = required > 0 ? Math.min(100, (balance / required) * 100) : 0;

  return (
    <div className="glass flex flex-col rounded-xl p-7">
      <div className="inline-flex w-fit rounded-lg bg-pablo-500/10 p-2.5 text-pablo-300">
        <Coins className="h-5 w-5" />
      </div>
      <h3 className="mt-4 font-display text-lg font-bold text-foreground">
        Détenir $PABLO
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Premium automatique et gratuit dès que votre solde $PABLO atteint le
        seuil — réévalué en continu, aucune action requise une fois acquis.
      </p>

      <div className="mt-6 space-y-2">
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-muted-foreground">Votre solde</span>
          <span className="text-tabular font-semibold text-foreground">
            {balance.toLocaleString("fr-FR")} $PABLO
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-white/5">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              holder.meetsThreshold ? "bg-success" : "bg-pablo-500",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex items-baseline justify-between text-xs text-muted-foreground">
          <span>Seuil requis</span>
          <span className="text-tabular">{required.toLocaleString("fr-FR")} $PABLO</span>
        </div>
      </div>

      {holder.meetsThreshold ? (
        <p className="mt-5 text-sm font-medium text-success">
          Seuil atteint — accès Premium actif.
        </p>
      ) : (
        <p className="mt-5 text-sm text-muted-foreground">
          Il vous manque{" "}
          <span className="text-tabular font-semibold text-foreground">
            {(required - balance).toLocaleString("fr-FR")} $PABLO
          </span>{" "}
          pour débloquer l'accès gratuit.
        </p>
      )}
    </div>
  );
}
