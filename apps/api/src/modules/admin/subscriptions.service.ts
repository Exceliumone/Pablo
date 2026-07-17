import type { AdminUserListItemDto } from "@pablo/shared-types";
import { prisma } from "../../lib/prisma.js";
import { logAudit } from "../../lib/audit.js";
import { reconcileSubscription } from "../billing/subscription.service.js";

export class AdminSubscriptionsError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

export interface ListSubscriptionsOptions {
  cursor?: string;
  limit: number;
  status?: "ACTIVE" | "GRACE" | "EXPIRED";
}

/** Reuses the same list shape as users.service.ts (each row already carries
 * its subscription summary) — this view just filters/sorts by that facet
 * instead of by role, so a dedicated endpoint keeps the "licences" concern
 * separate from the general user roster even though the underlying query
 * is a close sibling of listUsers. */
export async function listSubscriptions(opts: ListSubscriptionsOptions) {
  const where = opts.status
    ? { subscription: { status: opts.status } }
    : { subscription: { isNot: null } };

  const [rows, totalCount] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { subscription: { updatedAt: "desc" } },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      include: { wallets: true, subscription: true },
    }),
    prisma.user.count({ where }),
  ]);

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const lastRow = page.at(-1);

  const users: AdminUserListItemDto[] = page.map((u) => {
    const primary = u.wallets.find((w) => w.isPrimary) ?? u.wallets[0];
    const sub = u.subscription;
    return {
      id: u.id,
      role: u.role,
      status: u.status,
      createdAt: u.createdAt.toISOString(),
      primaryWallet: primary?.address ?? null,
      walletCount: u.wallets.length,
      subscription: {
        tier: (sub?.tier ?? "FREE") as AdminUserListItemDto["subscription"]["tier"],
        status: (sub?.status ?? "EXPIRED") as AdminUserListItemDto["subscription"]["status"],
        source: (sub?.source ?? null) as AdminUserListItemDto["subscription"]["source"],
        currentPeriodEnd: sub?.currentPeriodEnd?.toISOString() ?? null,
        graceUntil: sub?.graceUntil?.toISOString() ?? null,
      },
    };
  });

  return { users, nextCursor: hasMore && lastRow ? lastRow.id : null, totalCount };
}

/** Grants Premium outright, source ADMIN_GRANT — reconcileSubscriptionState
 * never auto-modifies an ACTIVE ADMIN_GRANT subscription (see
 * billing/subscription.service.ts), so this sticks until an admin revokes
 * it, independent of payment or holder status. */
export async function grantPremium(adminUserId: string, targetUserId: string, days: number) {
  const user = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!user) {
    throw new AdminSubscriptionsError("User not found.", 404);
  }

  const now = new Date();
  const currentPeriodEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  await prisma.subscription.upsert({
    where: { userId: targetUserId },
    create: {
      userId: targetUserId,
      tier: "PREMIUM",
      status: "ACTIVE",
      source: "ADMIN_GRANT",
      startedAt: now,
      currentPeriodEnd,
      graceUntil: null,
    },
    update: {
      tier: "PREMIUM",
      status: "ACTIVE",
      source: "ADMIN_GRANT",
      startedAt: now,
      currentPeriodEnd,
      graceUntil: null,
    },
  });

  await logAudit({
    actorType: "ADMIN",
    actorUserId: adminUserId,
    action: "subscription.grant",
    meta: { targetUserId, days },
  });
}

/**
 * Drops the ADMIN_GRANT and resets to a safe EXPIRED/FREE baseline in the
 * same write — not "clear the grant fields and hope reconciliation fixes
 * the status", because reconciliation needs a live $PABLO-balance RPC call
 * and can throw outright when RPC is unavailable. Leaving status/tier
 * stale at ACTIVE/PREMIUM in that case would make revoke silently not
 * revoke anything. The best-effort reconcile below can only ever upgrade
 * this baseline back up (a real payment period or genuine holder balance),
 * never leave it looking revoked when it isn't.
 */
export async function revokePremium(adminUserId: string, targetUserId: string) {
  const existing = await prisma.subscription.findUnique({ where: { userId: targetUserId } });
  if (!existing) {
    throw new AdminSubscriptionsError("User has no subscription record.", 404);
  }

  // Only the grant's own period belongs to this revoke — a real payment
  // period sitting underneath an admin grant (unusual, but not impossible)
  // shouldn't be destroyed by revoking the grant.
  const clearPeriod = existing.source === "ADMIN_GRANT";

  await prisma.subscription.update({
    where: { userId: targetUserId },
    data: {
      status: "EXPIRED",
      tier: "FREE",
      source: null,
      ...(clearPeriod ? { currentPeriodEnd: null, graceUntil: null } : {}),
    },
  });

  await logAudit({
    actorType: "ADMIN",
    actorUserId: adminUserId,
    action: "subscription.revoke",
    meta: { targetUserId, clearedPeriod: clearPeriod },
  });

  // Best-effort upgrade — if the user has a real payment period left or
  // genuinely holds enough $PABLO, this restores ACTIVE. A failure here
  // (RPC unavailable) just leaves the safe EXPIRED/FREE baseline set above,
  // which the holder sweep or the user's next GET /billing/subscription
  // will reconcile properly once RPC is reachable.
  await reconcileSubscription(targetUserId).catch(() => undefined);
}
