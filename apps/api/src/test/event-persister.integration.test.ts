import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import type { FastifyInstance } from "fastify";
import type { BotEventDto } from "@pablo/shared-types";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { startEventPersister } from "../jobs/event-persister.js";
import { buildTestApp, seedUser, createIdentity } from "./helpers.js";

/**
 * Regression test for the Phase 4 race: ioredis's "pmessage" handler
 * doesn't wait for a prior handler's promise before firing the next one,
 * so a BUY immediately followed by a SELL on the same mint could have the
 * SELL's "find the open position" query race the BUY's still-in-flight
 * insert and find nothing to close — event-persister.ts now serializes
 * processing by chaining onto one promise (see the `queue` comment there).
 * This test publishes BUY then SELL back-to-back over real Redis pub/sub
 * against the real persister and asserts the position actually closes —
 * before the fix this was flaky-to-reliably-failing under exactly this
 * sequence.
 */
describe("event-persister: BUY immediately followed by SELL never races", () => {
  let app: FastifyInstance;
  let publisher: Redis;
  let stopPersister: () => void;
  let userId: string;

  beforeEach(async () => {
    const identity = createIdentity();
    const user = await seedUser({ identity });
    userId = user.id;
    publisher = new Redis(env.REDIS_URL);
    // Reuses a real Fastify instance purely for its already-configured pino
    // logger — event-persister.ts only needs the FastifyBaseLogger shape.
    app = await buildTestApp();
    stopPersister = startEventPersister(app.log);
    // Give the persister's psubscribe a moment to actually attach before
    // we publish — pub/sub delivery only reaches subscribers connected at
    // publish time.
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  afterEach(async () => {
    stopPersister();
    publisher.disconnect();
    await app.close();
  });

  it("closes the position instead of silently no-op'ing on a not-yet-committed BUY", async () => {
    const mint = "raceMint111111111111111111111111111111";
    const channel = `executor:events:${userId}`;

    const buy: Extract<BotEventDto, { type: "trade" }> = {
      type: "trade",
      userId,
      mint,
      side: "BUY",
      dex: "PumpFun",
      priceSol: 0.001,
      amountToken: 1000,
      amountSol: 1,
      txSignature: null,
      reason: null,
      at: new Date().toISOString(),
    };
    const sell: Extract<BotEventDto, { type: "trade" }> = {
      ...buy,
      side: "SELL",
      priceSol: 0.0015,
      amountSol: 1.5,
      txSignature: "5" + "x".repeat(87),
      reason: "TAKE_PROFIT",
    };

    // Back-to-back, no await between them — exactly the sequence that
    // exposed the race (a fast v1 heuristic can react within milliseconds).
    await publisher.publish(channel, JSON.stringify(buy));
    await publisher.publish(channel, JSON.stringify(sell));

    // Processing is async on the persister side — poll briefly instead of
    // a single fixed sleep, since exact timing isn't guaranteed.
    let position = null;
    for (let i = 0; i < 40; i++) {
      position = await prisma.position.findFirst({ where: { userId, tokenMint: mint } });
      if (position?.status === "CLOSED") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(position).not.toBeNull();
    expect(position?.status).toBe("CLOSED");
    expect(position?.realizedPnlSol).toBeCloseTo(0.5, 5);

    const trades = await prisma.trade.findMany({ where: { userId, tokenMint: mint } });
    expect(trades).toHaveLength(2);
  });
});
