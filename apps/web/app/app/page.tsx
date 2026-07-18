"use client";

import { Loader2, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BotControlPanel } from "@/components/bot/bot-control-panel";
import { BotEventFeed } from "@/components/bot/bot-event-feed";
import { useAuth } from "@/components/providers/auth-provider";
import { useBot } from "@/lib/use-bot";
import { useBotEvents } from "@/lib/use-bot-events";

export default function SniperPage() {
  const { accessToken } = useAuth();
  const { status, loading, error, start, stop, actionPending } = useBot(accessToken);
  // The live feed (and the "Flux temps réel" indicator it drives) should
  // only be connected while this user's bot is actually running or coming
  // up — not merely while the dashboard tab happens to be open.
  const botActive = status !== null && (status.status === "RUNNING" || status.status === "STARTING");
  const { events, connected } = useBotEvents(accessToken, botActive);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-pablo-400">Sniper</p>
        <h1 className="mt-3 text-balance font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
          Pilotez votre bot
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Scanner partagé, exécution dédiée à votre wallet — démarrez, observez en direct. Les
          réglages se trouvent dans l&apos;onglet Réglages.
        </p>
      </div>

      {loading && !status && (
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

      {status && (
        <BotControlPanel
          status={status}
          onStart={start}
          onStop={stop}
          pending={actionPending}
          wsConnected={connected}
        />
      )}

      <BotEventFeed events={events} />
    </div>
  );
}
