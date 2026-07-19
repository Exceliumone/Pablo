"use client";

import { useState } from "react";
import type { BotEventDto } from "@pablo/shared-types";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, ChevronDown, ChevronRight, Radar, Radio } from "lucide-react";
import { EntityLink } from "@/components/ui/entity-link";
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
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="font-medium text-foreground">{isBuy ? "Achat" : "Vente"}</span>
          <EntityLink kind="token" value={event.mint} className="text-muted-foreground" />
          {event.txSignature && (
            <EntityLink
              kind="tx"
              value={event.txSignature}
              label="tx"
              className="text-muted-foreground"
            />
          )}
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
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground">
          Nouveau token détecté
          <EntityLink kind="token" value={event.mint} className="text-foreground" />
          sur {event.dex}
        </span>
        <span className="text-tabular text-xs text-muted-foreground">{time}</span>
      </div>
    );
  }

  if (event.type === "error") {
    return <ErrorRow message={event.message} time={time} />;
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

/** Executor error messages can now carry a full technical detail (RPC
 * error chain + on-chain simulation logs, see apps/engine-bridge/src/bin/
 * executor.rs) after their first line — shown collapsed by default so the
 * feed stays scannable, with a click to expand the raw detail for
 * diagnosing the real cause (insufficient funds, slippage exceeded,
 * IncorrectProgramId, ...) instead of a generic summary. */
function ErrorRow({ message, time }: { message: string; time: string }) {
  const [expanded, setExpanded] = useState(false);
  const newlineIndex = message.indexOf("\n");
  const summary = newlineIndex === -1 ? message : message.slice(0, newlineIndex);
  const details = newlineIndex === -1 ? null : message.slice(newlineIndex + 1);

  return (
    <div className="border-b border-surface-border/10 py-2.5 text-sm last:border-0">
      <button
        type="button"
        onClick={() => details && setExpanded((prev) => !prev)}
        className={cn(
          "flex w-full items-center gap-3 text-left",
          details && "cursor-pointer",
        )}
        disabled={!details}
      >
        <span className="rounded-md bg-danger/10 p-1.5 text-danger">
          <AlertTriangle className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-danger">{summary}</span>
        {details && (
          expanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )
        )}
        <span className="text-tabular text-xs text-muted-foreground">{time}</span>
      </button>
      {expanded && details && (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-3 text-xs text-muted-foreground">
          {details}
        </pre>
      )}
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
