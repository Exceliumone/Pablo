import type { AdminUserDetailDto, AdminUserListItemDto, AdminUserPatchDto } from "@pablo/shared-types";
import { prisma } from "../../lib/prisma.js";
import { logAudit } from "../../lib/audit.js";

export class AdminUsersError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

function toSubscriptionSummary(sub: {
  tier: string;
  status: string;
  source: string | null;
  currentPeriodEnd: Date | null;
  graceUntil: Date | null;
} | null) {
  return {
    tier: (sub?.tier ?? "FREE") as AdminUserListItemDto["subscription"]["tier"],
    status: (sub?.status ?? "EXPIRED") as AdminUserListItemDto["subscription"]["status"],
    source: (sub?.source ?? null) as AdminUserListItemDto["subscription"]["source"],
    currentPeriodEnd: sub?.currentPeriodEnd?.toISOString() ?? null,
    graceUntil: sub?.graceUntil?.toISOString() ?? null,
  };
}

export interface ListUsersOptions {
  cursor?: string;
  limit: number;
}

export async function listUsers(opts: ListUsersOptions) {
  const [rows, totalCount] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      include: {
        wallets: true,
        subscription: true,
      },
    }),
    prisma.user.count(),
  ]);

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const lastRow = page.at(-1);

  const users: AdminUserListItemDto[] = page.map((u) => {
    const primary = u.wallets.find((w) => w.isPrimary) ?? u.wallets[0];
    return {
      id: u.id,
      role: u.role,
      status: u.status,
      createdAt: u.createdAt.toISOString(),
      primaryWallet: primary?.address ?? null,
      walletCount: u.wallets.length,
      subscription: toSubscriptionSummary(u.subscription),
    };
  });

  return {
    users,
    nextCursor: hasMore && lastRow ? lastRow.id : null,
    totalCount,
  };
}

export async function getUserDetail(userId: string): Promise<AdminUserDetailDto> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      wallets: true,
      subscription: true,
      tradingWallet: true,
      botSettings: true,
    },
  });
  if (!user) {
    throw new AdminUsersError("User not found.", 404);
  }

  const totalTrades = await prisma.trade.count({ where: { userId } });

  return {
    id: user.id,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
    email: user.email,
    wallets: user.wallets.map((w) => ({
      address: w.address,
      provider: w.provider,
      isPrimary: w.isPrimary,
    })),
    subscription: toSubscriptionSummary(user.subscription),
    tradingWalletPublicKey: user.tradingWallet?.publicKey ?? null,
    botIsActive: user.botSettings?.isActive ?? false,
    totalTrades,
  };
}

/**
 * Role/status changes only — subscription grants/revokes live in
 * subscriptions.service.ts since they're a distinct concern with their
 * own audit action names. Refuses to let an admin change their own role,
 * a cheap guard against locking every admin out of the console at once.
 */
export async function updateUser(adminUserId: string, targetUserId: string, patch: AdminUserPatchDto) {
  if (patch.role !== undefined && targetUserId === adminUserId) {
    throw new AdminUsersError("You can't change your own role.", 400);
  }

  const existing = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!existing) {
    throw new AdminUsersError("User not found.", 404);
  }

  const updated = await prisma.user.update({
    where: { id: targetUserId },
    data: {
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    },
  });

  // Setting BANNED/SUSPENDED is meant to take effect immediately, not "on
  // next refresh" — revoke every session so POST /auth/refresh (which does
  // check status, see auth.service.ts) can never mint the user a new
  // access token again. Their current access token, if any, still works
  // until it naturally expires (≤15m by default) — the same bounded
  // exposure every role change already accepts.
  if (patch.status !== undefined && patch.status !== "ACTIVE") {
    await prisma.session.updateMany({
      where: { userId: targetUserId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  await logAudit({
    actorType: "ADMIN",
    actorUserId: adminUserId,
    action: "user.update",
    meta: { targetUserId, patch, previousRole: existing.role, previousStatus: existing.status },
  });

  return updated;
}
