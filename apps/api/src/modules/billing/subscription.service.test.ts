import { describe, expect, it } from "vitest";
import { SubStatus, SubSource, SubTier } from "@prisma/client";
import { reconcileSubscriptionState } from "./subscription.service.js";

const NOW = new Date("2026-07-17T12:00:00Z");
const past = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);
const future = (hours: number) => new Date(NOW.getTime() + hours * 60 * 60 * 1000);

const FRESH = { status: SubStatus.EXPIRED, source: null, graceUntil: null, currentPeriodEnd: null };

describe("reconcileSubscriptionState", () => {
  it("a brand new user with no payment and no holdings stays EXPIRED/FREE", () => {
    const result = reconcileSubscriptionState(FRESH, false, false, 3, NOW);
    expect(result).toEqual({
      status: SubStatus.EXPIRED,
      tier: SubTier.FREE,
      source: null,
      graceUntil: null,
    });
  });

  it("an unpaid, non-holder user meeting the token threshold becomes ACTIVE/PREMIUM/HOLDER", () => {
    const result = reconcileSubscriptionState(FRESH, false, true, 3, NOW);
    expect(result).toEqual({
      status: SubStatus.ACTIVE,
      tier: SubTier.PREMIUM,
      source: SubSource.HOLDER,
      graceUntil: null,
    });
  });

  it("a paying, non-holder user becomes ACTIVE/PREMIUM/PAYMENT", () => {
    const result = reconcileSubscriptionState(FRESH, true, false, 3, NOW);
    expect(result.status).toBe(SubStatus.ACTIVE);
    expect(result.tier).toBe(SubTier.PREMIUM);
    expect(result.source).toBe(SubSource.PAYMENT);
  });

  it("meeting both conditions reports HOLDER as the source (cosmetic only — access is identical)", () => {
    const result = reconcileSubscriptionState(FRESH, true, true, 3, NOW);
    expect(result.status).toBe(SubStatus.ACTIVE);
    expect(result.source).toBe(SubSource.HOLDER);
  });

  it("a payment that just lapsed starts a fresh grace window instead of expiring immediately", () => {
    const current = {
      status: SubStatus.ACTIVE,
      source: SubSource.PAYMENT,
      graceUntil: null,
      currentPeriodEnd: past(1),
    };
    const result = reconcileSubscriptionState(current, false, false, 3, NOW);
    expect(result.status).toBe(SubStatus.GRACE);
    expect(result.tier).toBe(SubTier.PREMIUM); // grace keeps access, per the spec
    expect(result.graceUntil?.getTime()).toBe(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
  });

  it("an existing grace window in the future is preserved verbatim, not restarted", () => {
    const existingGrace = future(10);
    const current = {
      status: SubStatus.GRACE,
      source: SubSource.HOLDER,
      graceUntil: existingGrace,
      currentPeriodEnd: null,
    };
    const result = reconcileSubscriptionState(current, false, false, 3, NOW);
    expect(result.status).toBe(SubStatus.GRACE);
    expect(result.graceUntil).toBe(existingGrace);
  });

  it("a grace window that has fully elapsed expires the subscription to FREE", () => {
    const current = {
      status: SubStatus.GRACE,
      source: SubSource.PAYMENT,
      graceUntil: past(1),
      currentPeriodEnd: past(48),
    };
    const result = reconcileSubscriptionState(current, false, false, 3, NOW);
    expect(result).toEqual({
      status: SubStatus.EXPIRED,
      tier: SubTier.FREE,
      source: null,
      graceUntil: null,
    });
  });

  it("gracePeriodDays = 0 (admin disabled grace) expires immediately on lapse", () => {
    const current = {
      status: SubStatus.ACTIVE,
      source: SubSource.PAYMENT,
      graceUntil: null,
      currentPeriodEnd: past(1),
    };
    const result = reconcileSubscriptionState(current, false, false, 0, NOW);
    expect(result.status).toBe(SubStatus.EXPIRED);
  });

  it("regaining the holder threshold during grace clears the grace window", () => {
    const current = {
      status: SubStatus.GRACE,
      source: SubSource.HOLDER,
      graceUntil: future(10),
      currentPeriodEnd: null,
    };
    const result = reconcileSubscriptionState(current, false, true, 3, NOW);
    expect(result.status).toBe(SubStatus.ACTIVE);
    expect(result.graceUntil).toBeNull();
  });

  it("an ADMIN_GRANT subscription is never touched by payment/holder reconciliation", () => {
    const current = {
      status: SubStatus.ACTIVE,
      source: SubSource.ADMIN_GRANT,
      graceUntil: null,
      currentPeriodEnd: null,
    };
    const result = reconcileSubscriptionState(current, false, false, 3, NOW);
    expect(result).toEqual({
      status: SubStatus.ACTIVE,
      tier: SubTier.PREMIUM,
      source: SubSource.ADMIN_GRANT,
      graceUntil: null,
    });
  });

  it("a currentPeriodEnd exactly at `now` counts as lapsed, not active", () => {
    const current = { ...FRESH, status: SubStatus.ACTIVE, currentPeriodEnd: NOW };
    const isPaidActive = current.currentPeriodEnd > NOW; // mirrors the service's own check
    const result = reconcileSubscriptionState(current, isPaidActive, false, 3, NOW);
    expect(result.status).toBe(SubStatus.GRACE);
  });
});
