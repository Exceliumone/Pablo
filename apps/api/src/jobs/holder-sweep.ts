import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../lib/prisma.js";
import { reconcileSubscription } from "../modules/billing/subscription.service.js";

const SWEEP_INTERVAL_MS = 5 * 60_000;
const DELAY_BETWEEN_USERS_MS = 250; // keep RPC calls spaced out

/**
 * Reconciles every user who has at least one linked wallet, so a $PABLO
 * balance dropping below the threshold gets caught (and the grace period
 * clock started) even if that user never opens the app. This is a
 * single-process interval, not a real job queue — fine at today's scale;
 * the architecture doc flags Helius balance webhooks as the production
 * upgrade path once this becomes the bottleneck (docs/ARCHITECTURE.md §12).
 */
export function startHolderSweep(logger: FastifyBaseLogger) {
  const timer = setInterval(async () => {
    const users = await prisma.user.findMany({
      where: { wallets: { some: {} } },
      select: { id: true },
    });

    for (const user of users) {
      try {
        await reconcileSubscription(user.id);
      } catch (err) {
        logger.warn({ err, userId: user.id }, "holder sweep: reconcile failed for user");
      }
      await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_USERS_MS));
    }
  }, SWEEP_INTERVAL_MS);

  timer.unref();
  return () => clearInterval(timer);
}
