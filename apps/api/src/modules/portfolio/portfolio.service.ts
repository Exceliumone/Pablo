import type { PortfolioDto, PositionDto } from "@pablo/shared-types";
import { prisma } from "../../lib/prisma.js";

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
