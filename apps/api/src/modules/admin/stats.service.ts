import type { PlatformStatsDto } from "@pablo/shared-types";
import { prisma } from "../../lib/prisma.js";
import { listExecutors } from "../../lib/engine-bridge-client.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export async function getPlatformStats(): Promise<PlatformStatsDto> {
  const sevenDaysAgo = new Date(Date.now() - SEVEN_DAYS_MS);

  const [
    totalUsers,
    newUsersLast7d,
    activeSubscriptions,
    premiumViaPayment,
    premiumViaHolder,
    premiumViaAdminGrant,
    totalTrades,
    buyVolume,
    executors,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
    prisma.subscription.count({ where: { status: "ACTIVE" } }),
    prisma.subscription.count({ where: { status: "ACTIVE", source: "PAYMENT" } }),
    prisma.subscription.count({ where: { status: "ACTIVE", source: "HOLDER" } }),
    prisma.subscription.count({ where: { status: "ACTIVE", source: "ADMIN_GRANT" } }),
    prisma.trade.count(),
    prisma.trade.aggregate({ where: { side: "BUY" }, _sum: { amountSol: true } }),
    listExecutors().catch(() => null),
  ]);

  return {
    totalUsers,
    newUsersLast7d,
    activeSubscriptions,
    premiumViaPayment,
    premiumViaHolder,
    premiumViaAdminGrant,
    totalTrades,
    totalBuyVolumeSol: buyVolume._sum.amountSol ?? 0,
    botsRunning: executors ? executors.filter((e) => e.status === "RUNNING").length : null,
  };
}
