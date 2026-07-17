import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { authHeader, buildTestApp, cookieHeader, createIdentity, loginOk, seedUser } from "./helpers.js";

describe("admin: role gate + user/subscription management", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("a SUBSCRIBER is forbidden from every /admin/* console route", async () => {
    const identity = createIdentity();
    const { accessToken } = await loginOk(app, identity);

    const res = await app.inject({ method: "GET", url: "/admin/users", headers: authHeader(accessToken) });
    expect(res.statusCode).toBe(403);
  });

  it("an unauthenticated request to /admin/* is rejected before the role check", async () => {
    const res = await app.inject({ method: "GET", url: "/admin/users" });
    expect(res.statusCode).toBe(401);
  });

  it("an ADMIN can list and patch users; a status change is reflected immediately", async () => {
    const adminIdentity = createIdentity();
    await seedUser({ identity: adminIdentity, role: "ADMIN" });
    const { accessToken: adminToken } = await loginOk(app, adminIdentity);

    const targetIdentity = createIdentity();
    const target = await seedUser({ identity: targetIdentity, role: "SUBSCRIBER" });

    const list = await app.inject({ method: "GET", url: "/admin/users", headers: authHeader(adminToken) });
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as { users: { id: string }[] };
    expect(listBody.users.some((u) => u.id === target.id)).toBe(true);

    const patch = await app.inject({
      method: "PATCH",
      url: `/admin/users/${target.id}`,
      headers: authHeader(adminToken),
      payload: { status: "SUSPENDED" },
    });
    expect(patch.statusCode).toBe(200);

    const dbUser = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    expect(dbUser.status).toBe("SUSPENDED");
  });

  it("an admin can't demote/change their own role (self-lockout guard)", async () => {
    const adminIdentity = createIdentity();
    const admin = await seedUser({ identity: adminIdentity, role: "ADMIN" });
    const { accessToken } = await loginOk(app, adminIdentity);

    const res = await app.inject({
      method: "PATCH",
      url: `/admin/users/${admin.id}`,
      headers: authHeader(accessToken),
      payload: { role: "SUBSCRIBER" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("suspending a user immediately revokes their sessions — a live refresh token stops working", async () => {
    const adminIdentity = createIdentity();
    await seedUser({ identity: adminIdentity, role: "ADMIN" });
    const { accessToken: adminToken } = await loginOk(app, adminIdentity);

    const targetIdentity = createIdentity();
    await seedUser({ identity: targetIdentity, role: "SUBSCRIBER" });
    const { refreshToken: targetRefresh, user: targetUser } = await loginOk(app, targetIdentity);

    // The session exists and is live before the ban.
    const preBan = await app.inject({ method: "POST", url: "/auth/refresh", headers: cookieHeader(targetRefresh) });
    expect(preBan.statusCode).toBe(200);
    // preBan itself rotated the session — grab the freshly-rotated cookie.
    const rotated = preBan.cookies.find((c) => c.name === "pablo_refresh")?.value;
    if (!rotated) throw new Error("missing rotated refresh cookie");

    const ban = await app.inject({
      method: "PATCH",
      url: `/admin/users/${targetUser.id}`,
      headers: authHeader(adminToken),
      payload: { status: "BANNED" },
    });
    expect(ban.statusCode).toBe(200);

    const postBan = await app.inject({ method: "POST", url: "/auth/refresh", headers: cookieHeader(rotated) });
    expect(postBan.statusCode).toBe(401);
  });

  it("granting Premium sets ACTIVE/PREMIUM with a currentPeriodEnd; revoking clears it back to FREE/EXPIRED", async () => {
    const adminIdentity = createIdentity();
    await seedUser({ identity: adminIdentity, role: "ADMIN" });
    const { accessToken: adminToken } = await loginOk(app, adminIdentity);

    const targetIdentity = createIdentity();
    const target = await seedUser({ identity: targetIdentity, role: "SUBSCRIBER" });

    const grant = await app.inject({
      method: "POST",
      url: `/admin/subscriptions/${target.id}/grant`,
      headers: authHeader(adminToken),
      payload: { days: 30 },
    });
    expect(grant.statusCode).toBe(200);

    let sub = await prisma.subscription.findUniqueOrThrow({ where: { userId: target.id } });
    expect(sub.status).toBe("ACTIVE");
    expect(sub.tier).toBe("PREMIUM");
    expect(sub.source).toBe("ADMIN_GRANT");
    expect(sub.currentPeriodEnd).not.toBeNull();

    const revoke = await app.inject({
      method: "POST",
      url: `/admin/subscriptions/${target.id}/revoke`,
      headers: authHeader(adminToken),
    });
    expect(revoke.statusCode).toBe(200);

    sub = await prisma.subscription.findUniqueOrThrow({ where: { userId: target.id } });
    expect(sub.status).toBe("EXPIRED");
    expect(sub.tier).toBe("FREE");
  });

  it("every admin mutation is audit-logged with the actor and the change", async () => {
    const adminIdentity = createIdentity();
    const admin = await seedUser({ identity: adminIdentity, role: "ADMIN" });
    const { accessToken: adminToken } = await loginOk(app, adminIdentity);

    const targetIdentity = createIdentity();
    const target = await seedUser({ identity: targetIdentity, role: "SUBSCRIBER" });

    await app.inject({
      method: "PATCH",
      url: `/admin/users/${target.id}`,
      headers: authHeader(adminToken),
      payload: { status: "SUSPENDED" },
    });

    const logs = await prisma.auditLog.findMany({ where: { action: "user.update" } });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.userId).toBe(admin.id);
  });

  it("PATCH /admin/users/:id is rate-limited past its configured ceiling", async () => {
    const adminIdentity = createIdentity();
    await seedUser({ identity: adminIdentity, role: "ADMIN" });
    const { accessToken: adminToken } = await loginOk(app, adminIdentity);

    const targetIdentity = createIdentity();
    const target = await seedUser({ identity: targetIdentity, role: "SUBSCRIBER" });

    const requests = Array.from({ length: 31 }, () =>
      app.inject({
        method: "PATCH",
        url: `/admin/users/${target.id}`,
        headers: authHeader(adminToken),
        payload: {},
      }),
    );
    const results = await Promise.all(requests);
    // Configured ceiling is 30/min (users.routes.ts) — the 31st concurrent
    // request in the same window must be throttled, not silently accepted.
    expect(results.some((r) => r.statusCode === 429)).toBe(true);
  });

  it(
    "GET /admin/config survives a cache hit — regression for a Redis round-trip bug found by " +
      "load-testing (Phase 7): JSON.stringify/parse turned updatedAt into a plain string, so every " +
      "request served from the 30s cache (i.e. most real traffic) 500'd on config.updatedAt.toISOString()",
    async () => {
      await prisma.platformConfig.create({
        data: {
          id: 1,
          pabloMintAddress: "mint1111111111111111111111111111111111",
          minHolderTokens: 1_000_000n,
          treasuryWalletAddress: "treasury111111111111111111111111111111",
        },
      });

      const miss = await app.inject({ method: "GET", url: "/admin/config" });
      expect(miss.statusCode).toBe(200);

      // Second call within the cache TTL — this is the path that broke.
      const hit = await app.inject({ method: "GET", url: "/admin/config" });
      expect(hit.statusCode).toBe(200);
      expect(hit.json().updatedAt).toBe(miss.json().updatedAt);
    },
  );
});
