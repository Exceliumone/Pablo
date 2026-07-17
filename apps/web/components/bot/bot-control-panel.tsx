"use client";

import type { BotStatusDto } from "@pablo/shared-types";
import { Loader2, Play, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<BotStatusDto["status"], string> = {
  STOPPED: "Arrêté",
  STARTING: "Démarrage…",
  RUNNING: "En cours",
  STOPPING: "Arrêt…",
  ERROR: "Erreur",
};

const STATUS_TONE: Record<BotStatusDto["status"], string> = {
  STOPPED: "text-muted-foreground",
  STARTING: "text-pablo-300",
  RUNNING: "text-success",
  STOPPING: "text-warning",
  ERROR: "text-danger",
};

export function BotControlPanel({
  status,
  onStart,
  onStop,
  pending,
  wsConnected,
}: {
  status: BotStatusDto;
  onStart: () => void;
  onStop: () => void;
  pending: boolean;
  wsConnected: boolean;
}) {
  const isRunning = status.status === "RUNNING" || status.status === "STARTING";

  return (
    <div className="glass flex flex-col gap-5 rounded-xl p-7">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span
            className={cn(
              "h-2.5 w-2.5 rounded-full",
              status.status === "RUNNING" && "animate-pulse-glow bg-success",
              status.status === "STARTING" || status.status === "STOPPING" ? "bg-pablo-400" : "",
              status.status === "STOPPED" && "bg-muted-foreground/40",
              status.status === "ERROR" && "bg-danger",
            )}
          />
          <div>
            <p className={cn("font-display text-lg font-bold", STATUS_TONE[status.status])}>
              {STATUS_LABEL[status.status]}
            </p>
            {status.pid && (
              <p className="text-tabular text-xs text-muted-foreground">pid {status.pid}</p>
            )}
          </div>
        </div>

        <Button
          variant={isRunning ? "glass" : "primary"}
          onClick={isRunning ? onStop : onStart}
          disabled={pending || status.status === "STARTING" || status.status === "STOPPING"}
        >
          {pending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : isRunning ? (
            <Square className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4" />
          )}
          {isRunning ? "Arrêter" : "Démarrer"}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
        <div>
          <p className="text-xs text-muted-foreground">Flux temps réel</p>
          <p className={cn("font-medium", wsConnected ? "text-success" : "text-muted-foreground")}>
            {wsConnected ? "Connecté" : "Déconnecté"}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Redémarrages</p>
          <p className="text-tabular font-medium text-foreground">{status.restartCount}</p>
        </div>
        <div className="col-span-2">
          <p className="text-xs text-muted-foreground">Dernier événement</p>
          <p className="text-tabular font-medium text-foreground">
            {status.lastEventAt ? new Date(status.lastEventAt).toLocaleTimeString("fr-FR") : "—"}
          </p>
        </div>
      </div>

      {status.lastError && (
        <p className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{status.lastError}</p>
      )}
    </div>
  );
}
