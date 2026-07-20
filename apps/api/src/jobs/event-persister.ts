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

// Exported so tests can XADD onto the same stream the real engine-bridge
// process writes to (see engine-bridge's events.rs/contract.rs
// EXECUTOR_EVENTS_STREAM — kept in sync by hand, same as the rest of the
// cross-language contract).
export const DURABLE_STREAM = "executor:events:durable";
const CONSUMER_GROUP = "event-persister";
// One process runs this loop (started once at boot in index.ts, no
// multi-instance deployment in this repo's infra — see
// infra/docker-compose.yml), so a fixed consumer name is fine; ioredis'
// XREADGROUP would need a distinct name per consumer if that ever changed.
const CONSUMER_NAME = "event-persister-1";

/**
 * Turns `trade`/`error` executor events into durable rows — Trade +
 * Position for trades, Notification for both. `opportunity`/`status`
 * events are relayed live over the WebSocket (ws/gateway.ts, still plain
 * pub/sub — a dropped *live* UI update is harmless) but intentionally not
 * persisted here: they're high-frequency and disposable, not history.
 *
 * Reads `EXECUTOR_EVENTS_STREAM`/`executor:events:durable` (a Redis Stream
 * every executor XADDs onto in addition to publishing on the per-user
 * pub/sub channel — see engine-bridge's events.rs) via a consumer group,
 * NOT the old `executor:events:*` pub/sub pattern. Pub/sub has no history:
 * a message published while this process is restarting/deploying (no
 * subscriber connected at that exact moment) was silently dropped forever
 * — for a `trade` event that meant a position either never got its closing
 * PnL recorded (stuck OPEN despite being sold) or, worse, a later
 * "closed_empty" cleanup would force-book a full loss on a position that
 * had actually already sold at a profit, since nothing remembered the
 * real sale ever happened. A Stream + consumer group means every event is
 * durably stored until this process explicitly XACKs it, and pending
 * (received-but-never-acked) entries from a crash are reclaimed on the
 * next startup instead of lost. Started once at boot in index.ts.
 */
export function startEventPersister(logger: FastifyBaseLogger) {
  const redis = new Redis(env.REDIS_URL);
  let stopped = false;

  // Redis preserves stream order, and this loop processes one XREADGROUP
  // batch fully (await-ing each entry in sequence, see below) before
  // fetching the next — unlike the old pmessage handler, there's no
  // separate queue needed to keep a BUY-then-SELL on the same mint from
  // racing each other.
  async function run() {
    try {
      await redis.xgroup("CREATE", DURABLE_STREAM, CONSUMER_GROUP, "0", "MKSTREAM");
    } catch (err) {
      // BUSYGROUP = group already exists from a previous boot — expected
      // on every restart, not an error.
      if (!(err instanceof Error) || !err.message.includes("BUSYGROUP")) {
        logger.error({ err }, "event-persister: failed to create consumer group");
      }
    }

    // Reclaim this consumer's own pending (delivered-but-never-acked)
    // entries from a previous crashed run before joining the live tail —
    // '0' means "from the start of my pending list", not "from the start
    // of the stream".
    await drainBacklog("0", logger);

    while (!stopped) {
      await drainBacklog(">", logger);
    }
  }

  async function drainBacklog(cursor: "0" | ">", logger: FastifyBaseLogger) {
    let reply;
    try {
      // ioredis' xreadgroup overloads don't include a COUNT variant — fine
      // here, this stream is low-volume (trade/error events only) so an
      // unbounded read per call is not a concern. Only the live-tail read
      // (cursor ">") blocks; a pending-backlog read (cursor "0") should
      // return immediately with whatever's already there.
      reply =
        cursor === ">"
          ? await redis.xreadgroup(
              "GROUP",
              CONSUMER_GROUP,
              CONSUMER_NAME,
              "BLOCK",
              5000,
              "STREAMS",
              DURABLE_STREAM,
              cursor,
            )
          : await redis.xreadgroup(
              "GROUP",
              CONSUMER_GROUP,
              CONSUMER_NAME,
              "STREAMS",
              DURABLE_STREAM,
              cursor,
            );
    } catch (err) {
      logger.error({ err }, "event-persister: xreadgroup failed, retrying");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return;
    }
    if (!reply) return;

    for (const [, entries] of reply as [string, [string, string[]][]][]) {
      for (const [entryId, fields] of entries) {
        const dataIndex = fields.indexOf("data");
        const message = dataIndex >= 0 ? fields[dataIndex + 1] : undefined;
        if (message !== undefined) {
          await handleMessage(message, logger);
        }
        await redis.xack(DURABLE_STREAM, CONSUMER_GROUP, entryId);
      }
    }
  }

  run().catch((err: unknown) => {
    logger.error({ err }, "event-persister: consumer loop crashed");
  });

  return () => {
    stopped = true;
    redis.disconnect();
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
