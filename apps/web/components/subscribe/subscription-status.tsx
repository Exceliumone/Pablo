import type { SubscriptionViewDto } from "@pablo/shared-types";
import { ShieldCheck, TriangleAlert, CircleOff } from "lucide-react";
import { cn } from "@/lib/utils";

const CONTENT: Record<
  SubscriptionViewDto["status"],
  { icon: typeof ShieldCheck; label: string; tone: string }
> = {
  ACTIVE: { icon: ShieldCheck, label: "Premium actif", tone: "text-success" },
  GRACE: { icon: TriangleAlert, label: "Période de grâce", tone: "text-warning" },
  EXPIRED: { icon: CircleOff, label: "Aucun abonnement actif", tone: "text-muted-foreground" },
};

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

export function SubscriptionStatus({ subscription }: { subscription: SubscriptionViewDto }) {
  const { icon: Icon, label, tone } = CONTENT[subscription.status];
  const periodEnd = formatDate(subscription.currentPeriodEnd);
  const graceUntil = formatDate(subscription.graceUntil);

  return (
    <div className="glass rounded-xl p-7">
      <div className="flex items-center gap-3">
        <span className={cn("rounded-lg bg-white/5 p-2.5", tone)}>
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <p className={cn("font-display text-xl font-bold", tone)}>{label}</p>
          {subscription.status === "ACTIVE" && subscription.source && (
            <p className="text-xs text-muted-foreground">
              {subscription.source === "HOLDER"
                ? "Via détention de $PABLO — réévalué en continu"
                : periodEnd
                  ? `Renouvellement le ${periodEnd}`
                  : null}
            </p>
          )}
          {subscription.status === "GRACE" && graceUntil && (
            <p className="text-xs text-warning/80">
              Accès Premium conservé jusqu'au {graceUntil} — régularisez avant cette date.
            </p>
          )}
          {subscription.status === "EXPIRED" && (
            <p className="text-xs text-muted-foreground">
              Payez en SOL ou détenez du $PABLO pour débloquer l'accès Premium.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
