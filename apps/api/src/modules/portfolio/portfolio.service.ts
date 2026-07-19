import type { PortfolioDto, PositionDto } from "@pablo/shared-types";
import { prisma } from "../../lib/prisma.js";
import { closePositionManually } from "../bot/bot.service.js";

export class PortfolioError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

function toPositionDto(p: {
  id: string;
  tokenMint: string;
  tokenSymbol: string | null;
  status: "OPEN" | "CLOSED";
  entryPriceSol: number;
  currentAmount: number;
  costBasisSol: number;
  realizedPnlSol: number;
  openedAt: Date;
  closedAt: Date | null;
}): PositionDto {
  return {
    id: p.id,
    tokenMint: p.tokenMint,
    tokenSymbol: p.tokenSymbol,
    status: p.status,
    entryPriceSol: p.entryPriceSol,
    currentAmount: p.currentAmount,
    costBasisSol: p.costBasisSol,
    realizedPnlSol: p.realizedPnlSol,
    openedAt: p.openedAt.toISOString(),
    closedAt: p.closedAt ? p.closedAt.toISOString() : null,
  };
}

/**
 * Open positions in full, plus the 50 most recently closed for context —
 * `summary` is a true aggregate over *all* history, not just what's
 * returned in `positions` (the full ledger lives at GET /trades).
 * No live on-chain price feed here (see docs/ARCHITECTURE.md's network
 * policy note), so this only ever reports realized PnL — unrealized PnL
 * would need a live price per open mint, which isn't available yet.
 */
export async function getPortfolio(userId: string): Promise<PortfolioDto> {
  const [openPositions, recentClosed, closedCount, closedAgg] = await Promise.all([
    prisma.position.findMany({ where: { userId, status: "OPEN" }, orderBy: { openedAt: "desc" } }),
    prisma.position.findMany({
      where: { userId, status: "CLOSED" },
      orderBy: { closedAt: "desc" },
      take: 50,
    }),
    prisma.position.count({ where: { userId, status: "CLOSED" } }),
    prisma.position.aggregate({
      where: { userId, status: "CLOSED" },
      _sum: { realizedPnlSol: true },
    }),
  ]);

  const openCostBasisSol = openPositions.reduce((sum, p) => sum + p.costBasisSol, 0);

  return {
    positions: [...openPositions, ...recentClosed].map(toPositionDto),
    summary: {
      openCount: openPositions.length,
      openCostBasisSol,
      closedCount,
      totalRealizedPnlSol: closedAgg._sum.realizedPnlSol ?? 0,
    },
  };
}

/**
 * Manual "Close Position" — lets a user force-sell a stuck position (e.g.
 * the bot's own auto-sell logic hit a bug and won't liquidate it) without
 * waiting on take-profit/stop-loss. Only accepts an id that's actually
 * this user's own OPEN position — this is what confirms both ownership
 * and that there's genuinely still something to close, since a raw mint
 * address alone would let a user "close" a position they don't hold or
 * one already closed. The actual sell happens asynchronously (the
 * executor picks up the command and executes on-chain); this only
 * confirms the request was accepted — the position row itself flips to
 * CLOSED once event-persister.ts processes the resulting Trade event, not
 * immediately when this returns.
 */
export async function closePosition(userId: string, positionId: string): Promise<void> {
  const position = await prisma.position.findFirst({
    where: { id: positionId, userId, status: "OPEN" },
  });
  if (!position) {
    throw new PortfolioError("Position introuvable ou déjà clôturée.", 404);
  }
  await closePositionManually(userId, position.tokenMint);
}
