import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { authHeader, buildTestApp, createIdentity, loginOk, seedUser } from "./helpers.js";

describe("bot: settings + start/stop gating", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("GET /bot/settings lazily creates a default settings row for a fresh user", async () => {
    const identity = createIdentity();
    const { accessToken } = await loginOk(app, identity);

    const res = await app.inject({ method: "GET", url: "/bot/settings", headers: authHeader(accessToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isActive).toBe(false);
    expect(body.amountPerBuySol).toBeGreaterThan(0);
  });

  it("PUT /bot/settings persists a partial patch and rejects isActive as a settings field", async () => {
    const identity = createIdentity();
    const { accessToken } = await loginOk(app, identity);

    const patch = await app.inject({
      method: "PUT",
      url: "/bot/settings",
      headers: authHeader(accessToken),
      payload: { amountPerBuySol: 0.2, takeProfitPct: 75 },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().amountPerBuySol).toBe(0.2);
    expect(patch.json().takeProfitPct).toBe(75);

    // isActive is deliberately omitted from the PUT schema (zod strips
    // unknown keys rather than rejecting them) — only /bot/start and
    // /bot/stop are allowed to actually flip it.
    const attempt = await app.inject({
      method: "PUT",
      url: "/bot/settings",
      headers: authHeader(accessToken),
      payload: { isActive: true },
    });
    expect(attempt.statusCode).toBe(200);
    expect(attempt.json().isActive).toBe(false);
  });

  it("POST /bot/start refuses a user with no active Premium subscription (402)", async () => {
    const identity = createIdentity();
    await seedUser({ identity, subscriptionStatus: "EXPIRED" });
    const { accessToken } = await loginOk(app, identity);

    const res = await app.inject({ method: "POST", url: "/bot/start", headers: authHeader(accessToken) });
    expect(res.statusCode).toBe(402);
  });

  it(
    "POST /bot/start for a Premium user fails gracefully when the engine-bridge orchestrator is unreachable " +
      "(this sandbox never runs it) — a 500, not a hang or a silently-accepted start",
    async () => {
      const identity = createIdentity();
      await seedUser({ identity, subscriptionStatus: "ACTIVE" });
      const { accessToken } = await loginOk(app, identity);

      const res = await app.inject({ method: "POST", url: "/bot/start", headers: authHeader(accessToken) });
      expect(res.statusCode).toBe(500);
    },
  );

  it("POST /bot/stop clears isActive in our own DB before it ever calls out to the orchestrator", async () => {
    const identity = createIdentity();
    const { accessToken, user } = await loginOk(app, identity);

    const { prisma } = await import("../lib/prisma.js");
    await prisma.botSettings.upsert({
      where: { userId: user.id },
      create: { userId: user.id, isActive: true },
      update: { isActive: true },
    });

    const res = await app.inject({ method: "POST", url: "/bot/stop", headers: authHeader(accessToken) });
    // The orchestrator itself is unreachable in this sandbox (same as
    // /bot/start above) — a dead orchestrator must not strand a user's bot
    // flagged as active in our own DB, regardless of the HTTP outcome here.
    expect([200, 500]).toContain(res.statusCode);

    const settings = await prisma.botSettings.findUniqueOrThrow({ where: { userId: user.id } });
    expect(settings.isActive).toBe(false);
  });
});
