import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { authHeader, buildTestApp, cookieHeader, createIdentity, login, loginOk, seedUser } from "./helpers.js";

describe("auth: SIWS login + session lifecycle", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("issues a nonce, verifies the signature, and creates a new SUBSCRIBER user on first login", async () => {
    const identity = createIdentity();
    const { accessToken, refreshToken, user } = await loginOk(app, identity);

    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();
    expect(user.role).toBe("SUBSCRIBER");

    const dbUser = await prisma.user.findUnique({ where: { id: user.id }, include: { wallets: true } });
    expect(dbUser?.wallets).toHaveLength(1);
    expect(dbUser?.wallets[0]?.address).toBe(identity.address);
  });

  it("rejects /auth/verify when no nonce was ever issued for that address", async () => {
    const identity = createIdentity();
    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { address: identity.address, signature: "not-a-real-signature-11111111", provider: "phantom" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a nonce signed with the wrong keypair", async () => {
    const identity = createIdentity();
    const impostor = createIdentity();

    const nonceRes = await app.inject({ method: "GET", url: `/auth/nonce?address=${identity.address}` });
    const { message } = nonceRes.json() as { message: string };

    const nacl = await import("tweetnacl");
    const bs58 = (await import("bs58")).default;
    // Signed by a different keypair than the one behind `identity.address`.
    const signature = bs58.encode(
      nacl.default.sign.detached(new TextEncoder().encode(message), impostor.keypair.secretKey),
    );

    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { address: identity.address, signature, provider: "phantom" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("a nonce can't be replayed — consuming it twice fails the second time", async () => {
    const identity = createIdentity();
    const nonceRes = await app.inject({ method: "GET", url: `/auth/nonce?address=${identity.address}` });
    const { message } = nonceRes.json() as { message: string };

    const nacl = await import("tweetnacl");
    const bs58 = (await import("bs58")).default;
    const signature = bs58.encode(
      nacl.default.sign.detached(new TextEncoder().encode(message), identity.keypair.secretKey),
    );

    const first = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { address: identity.address, signature, provider: "phantom" },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { address: identity.address, signature, provider: "phantom" },
    });
    expect(second.statusCode).toBe(400);
  });

  it("GET /auth/me requires a valid access token", async () => {
    const noAuth = await app.inject({ method: "GET", url: "/auth/me" });
    expect(noAuth.statusCode).toBe(401);

    const identity = createIdentity();
    const { accessToken } = await loginOk(app, identity);
    const authed = await app.inject({ method: "GET", url: "/auth/me", headers: authHeader(accessToken) });
    expect(authed.statusCode).toBe(200);
  });

  it("POST /auth/refresh rotates the session — the old refresh token stops working", async () => {
    const identity = createIdentity();
    const { refreshToken } = await loginOk(app, identity);

    const firstRefresh = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: cookieHeader(refreshToken),
    });
    expect(firstRefresh.statusCode).toBe(200);

    // Presenting the same (now-rotated) token again is a reuse — flagged as
    // a theft signal, not just "expired" (see auth.service.ts rotateSession).
    const reuse = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: cookieHeader(refreshToken),
    });
    expect(reuse.statusCode).toBe(401);
  });

  it("refresh-token reuse revokes the user's ENTIRE session family, not just the reused one", async () => {
    const identity = createIdentity();
    const { refreshToken: refreshA } = await loginOk(app, identity);
    // A second, independent login for the same identity — e.g. a second tab.
    const secondLoginRes = await login(app, identity);
    expect(secondLoginRes.statusCode).toBe(200);
    const refreshBCookie = secondLoginRes.cookies.find((c) => c.name === "pablo_refresh");
    if (!refreshBCookie) throw new Error("missing refresh cookie on second login");
    const refreshB = refreshBCookie.value;

    // Rotate A once (legitimate), then replay the now-stale A token (theft signal).
    await app.inject({ method: "POST", url: "/auth/refresh", headers: cookieHeader(refreshA) });
    const replay = await app.inject({ method: "POST", url: "/auth/refresh", headers: cookieHeader(refreshA) });
    expect(replay.statusCode).toBe(401);

    // Session B, never itself reused, should now ALSO be dead — the whole
    // family was burned as a precaution.
    const refreshBAttempt = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: cookieHeader(refreshB),
    });
    expect(refreshBAttempt.statusCode).toBe(401);
  });

  it("a BANNED user cannot log in, even with a correct signature", async () => {
    const identity = createIdentity();
    await seedUser({ identity, status: "BANNED" });

    const res = await login(app, identity);
    expect(res.statusCode).toBe(403);
  });

  it("a user banned mid-session loses refresh access immediately, not just on next natural expiry", async () => {
    const identity = createIdentity();
    const { refreshToken, user } = await loginOk(app, identity);

    await prisma.user.update({ where: { id: user.id }, data: { status: "BANNED" } });
    // Mirrors admin/users.service.ts updateUser: setting a non-ACTIVE status
    // revokes every open session so refresh can't outlive the ban.
    await prisma.session.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });

    const refreshAttempt = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: cookieHeader(refreshToken),
    });
    expect(refreshAttempt.statusCode).toBe(401);
  });

  it("POST /auth/logout revokes the session so it can no longer be refreshed", async () => {
    const identity = createIdentity();
    const { refreshToken } = await loginOk(app, identity);

    const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: cookieHeader(refreshToken) });
    expect(logout.statusCode).toBe(200);

    const refreshAfterLogout = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: cookieHeader(refreshToken),
    });
    expect(refreshAfterLogout.statusCode).toBe(401);
  });
});
