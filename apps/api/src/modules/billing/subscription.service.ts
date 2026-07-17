import { SubStatus, SubSource, SubTier } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { getPlatformConfig } from "../admin/platform-config.service.js";
import { checkHolderStatus, type HolderCheckResult } from "./holder.service.js";

interface ReconcileInput {
  status: SubStatus;
  source: SubSource | null;
  graceUntil: Date | null;
  currentPeriodEnd: Date | null;
}

interface ReconcileOutput {
  status: SubStatus;
  tier: SubTier;
  source: SubSource | null;
  graceUntil: Date | null;
}

/**
 * Pure state transition, kept separate from I/O so the grace-period edge
 * cases (paid lapses, holder balance drops, gracePeriodDays = 0) are easy
 * to reason about and to unit test later. Never touches an ADMIN_GRANT
 * subscription — those are managed by hand, not by this machine.
 */
export function reconcileSubscriptionState(
  current: ReconcileInput,
  isPaidActive: boolean,
  isHolderActive: boolean,
  gracePeriodDays: number,
  now: Date,
): ReconcileOutput {
  if (current.source === SubSource.ADMIN_GRANT && current.status === SubStatus.ACTIVE) {
    return {
      status: current.status,
      tier: SubTier.PREMIUM,
      source: current.source,
      graceUntil: current.graceUntil,
    };
  }

  if (isPaidActive || isHolderActive) {
    return {
      status: SubStatus.ACTIVE,
      tier: SubTier.PREMIUM,
      source: isHolderActive ? SubSource.HOLDER : SubSource.PAYMENT,
      graceUntil: null,
    };
  }

  const wasEverActive = current.status === SubStatus.ACTIVE || current.status === SubStatus.GRACE;
  let graceUntil = current.graceUntil;
  if (wasEverActive && !graceUntil) {
    graceUntil = new Date(now.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000);
  }

  if (graceUntil && graceUntil > now) {
    return { status: SubStatus.GRACE, tier: SubTier.PREMIUM, source: current.source, graceUntil };
  }

  return { status: SubStatus.EXPIRED, tier: SubTier.FREE, source: null, graceUntil: null };
}

export async function reconcileSubscription(userId: string) {
  const [config, sub, holder] = await Promise.all([
    getPlatformConfig(),
    prisma.subscription.upsert({
      where: { userId },
      create: { userId },
      update: {},
    }),
    checkHolderStatus(userId),
  ]);

  const now = new Date();
  const isPaidActive = Boolean(sub.currentPeriodEnd && sub.currentPeriodEnd > now);

  const next = reconcileSubscriptionState(
    sub,
    isPaidActive,
    holder.meetsThreshold,
    config.gracePeriodDays,
    now,
  );

  const updated = await prisma.subscription.update({
    where: { userId },
    data: next,
  });

  return { subscription: updated, holder };
}

export function toSubscriptionViewDto(
  subscription: Awaited<ReturnType<typeof reconcileSubscription>>["subscription"],
  holder: HolderCheckResult,
) {
  return {
    tier: subscription.tier,
    status: subscription.status,
    source: subscription.source,
    currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    graceUntil: subscription.graceUntil?.toISOString() ?? null,
    holder: {
      balance: holder.balanceRaw.toString(),
      requiredRaw: holder.requiredRaw.toString(),
      balanceHuman: holder.balanceHuman,
      requiredHuman: holder.requiredHuman,
      meetsThreshold: holder.meetsThreshold,
    },
  };
}

/** Called on payment confirmation — extends from the later of "now" or the
 * existing period end, so paying early never wastes days already owned. */
export async function extendPaidPeriod(userId: string, days: number) {
  const now = new Date();
  const sub = await prisma.subscription.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });

  const base = sub.currentPeriodEnd && sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
  const currentPeriodEnd = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

  await prisma.subscription.update({
    where: { userId },
    data: {
      currentPeriodEnd,
      startedAt: sub.startedAt ?? now,
    },
  });

  return reconcileSubscription(userId);
}
