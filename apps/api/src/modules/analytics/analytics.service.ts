import type { AnalyticsSummaryDto } from "@pablo/shared-types";
import { prisma } from "../../lib/prisma.js";

const PNL_CHART_DAYS = 14;

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * All computed in-process from a single user's rows — fine at today's
 * scale (bounded per-user history), not a substitute for a real OLAP
 * rollup once trade volume grows. Revisit if this page gets slow.
 */
export async function getAnalyticsSummary(userId: string): Promise<AnalyticsSummaryDto> {
  const [totalTrades, buyCount, sellCount, closedPositions] = await Promise.all([
    prisma.trade.count({ where: { userId } }),
    prisma.trade.count({ where: { userId, side: "BUY" } }),
    prisma.trade.count({ where: { userId, side: "SELL" } }),
    prisma.position.findMany({
      where: { userId, status: "CLOSED" },
      select: { realizedPnlSol: true, openedAt: true, closedAt: true },
    }),
  ]);

  const winCount = closedPositions.filter((p) => p.realizedPnlSol > 0).length;
  const lossCount = closedPositions.filter((p) => p.realizedPnlSol <= 0).length;
  const winRatePct = closedPositions.length > 0 ? (winCount / closedPositions.length) * 100 : null;
  const totalRealizedPnlSol = closedPositions.reduce((sum, p) => sum + p.realizedPnlSol, 0);

  const pnls = closedPositions.map((p) => p.realizedPnlSol);
  const bestTradePnlSol = pnls.length > 0 ? Math.max(...pnls) : null;
  const worstTradePnlSol = pnls.length > 0 ? Math.min(...pnls) : null;

  const holdTimesMinutes = closedPositions
    .filter((p): p is typeof p & { closedAt: Date } => p.closedAt !== null)
    .map((p) => (p.closedAt.getTime() - p.openedAt.getTime()) / 60_000);
  const avgHoldTimeMinutes =
    holdTimesMinutes.length > 0
      ? holdTimesMinutes.reduce((a, b) => a + b, 0) / holdTimesMinutes.length
      : null;

  const days: string[] = [];
  const now = new Date();
  for (let i = PNL_CHART_DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    days.push(utcDateKey(d));
  }
  const byDay = new Map<string, number>(days.map((d) => [d, 0]));
  for (const p of closedPositions) {
    if (!p.closedAt) continue;
    const key = utcDateKey(p.closedAt);
    if (byDay.has(key)) byDay.set(key, (byDay.get(key) ?? 0) + p.realizedPnlSol);
  }

  return {
    totalTrades,
    buyCount,
    sellCount,
    closedPositions: closedPositions.length,
    winCount,
    lossCount,
    winRatePct,
    totalRealizedPnlSol,
    bestTradePnlSol,
    worstTradePnlSol,
    avgHoldTimeMinutes,
    pnlByDay: days.map((date) => ({ date, realizedPnlSol: byDay.get(date) ?? 0 })),
  };
}
