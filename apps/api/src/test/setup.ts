import { afterAll, beforeEach } from "vitest";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";

/**
 * Runs against a real local Postgres + Redis (see apps/api/.env / CI's
 * service containers) — there is no mock/in-memory substitute here. Every
 * test starts from a genuinely clean slate, including PlatformConfig
 * (its own singleton row, no FK dependents) — a test suite has to be
 * repeatable across runs against the same persistent local DB, unlike a
 * real deployment where that row is long-lived bootstrap config.
 */
async function resetDb() {
  await prisma.$transaction([
    prisma.auditLog.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.position.deleteMany(),
    prisma.trade.deleteMany(),
    prisma.payment.deleteMany(),
    prisma.holderSnapshot.deleteMany(),
    prisma.session.deleteMany(),
    prisma.botSettings.deleteMany(),
    prisma.tradingWallet.deleteMany(),
    prisma.subscription.deleteMany(),
    prisma.walletLink.deleteMany(),
    prisma.whitelistEntry.deleteMany(),
    prisma.blacklistEntry.deleteMany(),
    prisma.user.deleteMany(),
    prisma.platformConfig.deleteMany(),
  ]);
}

beforeEach(async () => {
  await resetDb();
  await redis.flushdb();
});

afterAll(async () => {
  await prisma.$disconnect();
  redis.disconnect();
});
