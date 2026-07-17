"use client";

import { useState } from "react";
import type { AnalyticsSummaryDto } from "@pablo/shared-types";
import { cn } from "@/lib/utils";

function formatShortDate(dateKey: string): string {
  if (!dateKey) return "";
  return new Date(`${dateKey}T00:00:00Z`).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** Single-series signed bar chart (gain/loss per day) built from a zero
 * baseline — plain flex/CSS, no charting library. Color reuses the same
 * success/danger tokens already used for PnL sign elsewhere in the app
 * (positions table, event feed), so identity is never color-alone: the
 * readout line below the title spells out the exact value on hover. */
export function PnlChart({ data }: { data: AnalyticsSummaryDto["pnlByDay"] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const maxAbs = Math.max(...data.map((d) => Math.abs(d.realizedPnlSol)), 0.0001);
  const hoveredDay = hovered !== null ? data[hovered] : null;

  return (
    <div className="glass rounded-xl p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-lg font-bold text-foreground">PnL réalisé (14 jours)</h3>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-success" /> Gain
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-danger" /> Perte
          </span>
        </div>
      </div>

      <p className="text-tabular mt-1 h-4 text-xs text-muted-foreground">
        {hoveredDay
          ? `${formatShortDate(hoveredDay.date)} — ${hoveredDay.realizedPnlSol >= 0 ? "+" : ""}${hoveredDay.realizedPnlSol.toFixed(4)} SOL`
          : "Survolez une barre pour le détail"}
      </p>

      <div className="relative mt-4 h-40">
        <div aria-hidden className="absolute inset-x-0 top-1/2 h-px bg-surface-border/20" />
        <div className="flex h-full items-stretch gap-1">
          {data.map((d, i) => {
            const pct = (Math.abs(d.realizedPnlSol) / maxAbs) * 100;
            const isGain = d.realizedPnlSol >= 0;
            return (
              <div
                key={d.date}
                className="flex flex-1 flex-col"
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
              >
                <div className="flex flex-1 items-end justify-center">
                  {isGain && d.realizedPnlSol !== 0 && (
                    <div
                      className={cn(
                        "w-2/3 rounded-t-sm bg-success transition-opacity",
                        hovered !== null && hovered !== i && "opacity-50",
                      )}
                      style={{ height: `${pct}%` }}
                    />
                  )}
                </div>
                <div className="flex flex-1 items-start justify-center">
                  {!isGain && d.realizedPnlSol !== 0 && (
                    <div
                      className={cn(
                        "w-2/3 rounded-b-sm bg-danger transition-opacity",
                        hovered !== null && hovered !== i && "opacity-50",
                      )}
                      style={{ height: `${pct}%` }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-2 flex justify-between text-[10px] text-muted-foreground/70">
        <span>{formatShortDate(data[0]?.date ?? "")}</span>
        <span>{formatShortDate(data[Math.floor(data.length / 2)]?.date ?? "")}</span>
        <span>{formatShortDate(data.at(-1)?.date ?? "")}</span>
      </div>
    </div>
  );
}
