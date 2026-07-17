"use client";

import type { BotEventDto } from "@pablo/shared-types";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Radar, Radio } from "lucide-react";
import { cn } from "@/lib/utils";

function EventRow({ event }: { event: BotEventDto }) {
  const time = new Date(event.at).toLocaleTimeString("fr-FR");

  if (event.type === "trade") {
    const isBuy = event.side === "BUY";
    return (
      <div className="flex items-center gap-3 border-b border-surface-border/10 py-2.5 text-sm last:border-0">
        <span className={cn("rounded-md p-1.5", isBuy ? "bg-success/10 text-success" : "bg-danger/10 text-danger")}>
          {isBuy ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium text-foreground">{isBuy ? "Achat" : "Vente"}</span>{" "}
          <span className="text-tabular text-muted-foreground">{event.mint.slice(0, 6)}…</span>
          {event.reason && <span className="text-xs text-muted-foreground"> · {event.reason}</span>}
        </span>
        <span className="text-tabular text-xs text-muted-foreground">{time}</span>
      </div>
    );
  }

  if (event.type === "opportunity") {
    return (
      <div className="flex items-center gap-3 border-b border-surface-border/10 py-2.5 text-sm last:border-0">
        <span className="rounded-md bg-pablo-500/10 p-1.5 text-pablo-300">
          <Radar className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          Nouveau token détecté <span className="text-tabular text-foreground">{event.mint.slice(0, 6)}…</span> sur{" "}
          {event.dex}
        </span>
        <span className="text-tabular text-xs text-muted-foreground">{time}</span>
      </div>
    );
  }

  if (event.type === "error") {
    return (
      <div className="flex items-center gap-3 border-b border-surface-border/10 py-2.5 text-sm last:border-0">
        <span className="rounded-md bg-danger/10 p-1.5 text-danger">
          <AlertTriangle className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-danger">{event.message}</span>
        <span className="text-tabular text-xs text-muted-foreground">{time}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 border-b border-surface-border/10 py-2.5 text-sm last:border-0">
      <span className="rounded-md bg-white/5 p-1.5 text-muted-foreground">
        <Radio className="h-3.5 w-3.5" />
      </span>
      <span className="flex-1 text-muted-foreground">Statut : {event.status}</span>
      <span className="text-tabular text-xs text-muted-foreground">{time}</span>
    </div>
  );
}

export function BotEventFeed({ events }: { events: BotEventDto[] }) {
  return (
    <div className="glass flex flex-col rounded-xl p-7">
      <h3 className="font-display text-lg font-bold text-foreground">Activité en direct</h3>
      <div className="mt-3 max-h-96 overflow-y-auto">
        {events.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            En attente d&apos;activité — les détections et trades apparaîtront ici en temps réel.
          </p>
        ) : (
          events.map((event, i) => <EventRow key={`${event.at}-${i}`} event={event} />)
        )}
      </div>
    </div>
  );
}
