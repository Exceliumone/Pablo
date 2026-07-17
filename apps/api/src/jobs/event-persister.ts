import type { FastifyBaseLogger } from "fastify";
import type { BotEventDto } from "@pablo/shared-types";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";

type TradeEvent = Extract<BotEventDto, { type: "trade" }>;

function dexToProtocol(dex: string): string {
  switch (dex) {
    case "PumpFun":
      return "pumpfun";
    case "PumpSwap":
      return "pumpswap";
    case "RaydiumLaunchpad":
      return "raydium";
    default:
      return "auto";
  }
}

/**
 * The one process-wide Redis subscriber (unlike ws/gateway.ts, which opens
 * one per browser connection) that turns `trade`/`error` executor events
 * into durable rows — Trade + Position for trades, Notification for both.
 * `opportunity`/`status` events are relayed live over the WebSocket but
 * intentionally not persisted here: they're high-frequency and disposable,
 * not history. Started once at boot in index.ts.
 */
export function startEventPersister(logger: FastifyBaseLogger) {
  const subscriber = new Redis(env.REDIS_URL);

  subscriber.psubscribe("executor:events:*").catch((err: unknown) => {
    logger.error({ err }, "event-persister: failed to psubscribe");
  });

  // Redis preserves publish order within a single subscriber connection,
  // but the ioredis "pmessage" handler doesn't wait for a prior handler's
  // promise before firing the next one — a BUY immediately followed by a
  // SELL on the same mint (the common case: the v1 heuristic can react
  // within milliseconds) could otherwise have the SELL's "find the open
  // position" query race the BUY's still-in-flight insert and find
  // nothing to close. Chaining onto one promise serializes processing
  // back to the order Redis delivered it in.
  let queue: Promise<void> = Promise.resolve();
  subscriber.on("pmessage", (_pattern: string, _channel: string, message: string) => {
    queue = queue.then(() => handleMessage(message, logger));
  });

  return () => {
    subscriber.disconnect();
  };
}

async function handleMessage(message: string, logger: FastifyBaseLogger) {
  let event: BotEventDto;
  try {
    event = JSON.parse(message) as BotEventDto;
  } catch {
    return;
  }

  try {
    if (event.type === "trade") {
      await persistTrade(event);
    } else if (event.type === "error") {
      await prisma.notification.create({
        data: {
          userId: event.userId,
          type: "ERROR",
          title: "Erreur du bot",
          body: event.message,
        },
      });
    }
  } catch (err) {
    logger.error({ err, event }, "event-persister: failed to persist event");
  }
}

async function persistTrade(event: TradeEvent) {
  await prisma.trade.create({
    data: {
      userId: event.userId,
      tokenMint: event.mint,
      side: event.side,
      protocol: dexToProtocol(event.dex),
      priceSol: event.priceSol,
      amountToken: event.amountToken,
      amountSol: event.amountSol,
      txSignature: event.txSignature,
      status: event.txSignature ? "CONFIRMED" : "PENDING",
      reason: event.reason,
    },
  });

  if (event.side === "BUY") {
    await persistBuy(event);
  } else {
    await persistSell(event);
  }
}

async function persistBuy(event: TradeEvent) {
  const existing = await prisma.position.findFirst({
    where: { userId: event.userId, tokenMint: event.mint, status: "OPEN" },
  });

  if (existing) {
    const currentAmount = existing.currentAmount + event.amountToken;
    const costBasisSol = existing.costBasisSol + event.amountSol;
    await prisma.position.update({
      where: { id: existing.id },
      data: {
        currentAmount,
        costBasisSol,
        entryPriceSol: currentAmount > 0 ? costBasisSol / currentAmount : existing.entryPriceSol,
      },
    });
  } else {
    await prisma.position.create({
      data: {
        userId: event.userId,
        tokenMint: event.mint,
        entryPriceSol: event.priceSol,
        currentAmount: event.amountToken,
        costBasisSol: event.amountSol,
      },
    });
  }

  await prisma.notification.create({
    data: {
      userId: event.userId,
      type: "TRADE_EXECUTED",
      title: "Achat exécuté",
      body: `Achat de ${event.mint.slice(0, 6)}… pour ${event.amountSol.toFixed(3)} SOL`,
    },
  });
}

async function persistSell(event: TradeEvent) {
  // v1 sell heuristic always liquidates the whole tracked position (see
  // executor.rs), so this closes it outright rather than reducing it.
  const position = await prisma.position.findFirst({
    where: { userId: event.userId, tokenMint: event.mint, status: "OPEN" },
  });
  if (!position) return; // defensive — nothing to close, e.g. after a restart

  const realizedPnlSol = event.amountSol - position.costBasisSol;
  await prisma.position.update({
    where: { id: position.id },
    data: {
      status: "CLOSED",
      closedAt: new Date(),
      realizedPnlSol,
      currentAmount: 0,
    },
  });

  // The engine doesn't expose *which* sell condition fired, only
  // should_sell/is_emergency — realized PnL sign is the best available
  // proxy for TAKE_PROFIT vs. STOP_LOSS classification here.
  await prisma.notification.create({
    data: {
      userId: event.userId,
      type: realizedPnlSol >= 0 ? "TAKE_PROFIT" : "STOP_LOSS",
      title: realizedPnlSol >= 0 ? "Position clôturée en profit" : "Position clôturée en perte",
      body: `${event.mint.slice(0, 6)}… — PnL réalisé : ${realizedPnlSol.toFixed(4)} SOL`,
    },
  });
}
