import type { TradeDto, TradesPageDto } from "@pablo/shared-types";
import { prisma } from "../../lib/prisma.js";

function toTradeDto(t: {
  id: string;
  tokenMint: string;
  tokenSymbol: string | null;
  side: "BUY" | "SELL";
  protocol: string;
  priceSol: number;
  amountToken: number;
  amountSol: number;
  txSignature: string | null;
  status: "PENDING" | "CONFIRMED" | "FAILED";
  reason: string | null;
  createdAt: Date;
}): TradeDto {
  return {
    id: t.id,
    tokenMint: t.tokenMint,
    tokenSymbol: t.tokenSymbol,
    side: t.side,
    protocol: t.protocol,
    priceSol: t.priceSol,
    amountToken: t.amountToken,
    amountSol: t.amountSol,
    txSignature: t.txSignature,
    status: t.status,
    reason: t.reason,
    createdAt: t.createdAt.toISOString(),
  };
}

export interface ListTradesOptions {
  cursor?: string;
  limit: number;
  side?: "BUY" | "SELL";
}

/** Cursor pagination (not offset) so a live-growing trade history never
 * skips or repeats rows as new trades land between page fetches. */
export async function listTrades(userId: string, opts: ListTradesOptions): Promise<TradesPageDto> {
  const trades = await prisma.trade.findMany({
    where: {
      userId,
      ...(opts.side ? { side: opts.side } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });

  const hasMore = trades.length > opts.limit;
  const page = hasMore ? trades.slice(0, opts.limit) : trades;
  const lastRow = page.at(-1);

  return {
    trades: page.map(toTradeDto),
    nextCursor: hasMore && lastRow ? lastRow.id : null,
  };
}
