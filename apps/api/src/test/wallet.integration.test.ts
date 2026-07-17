import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { authHeader, buildTestApp, createIdentity, loginOk } from "./helpers.js";

describe("wallet: custodial trading wallet provisioning + withdrawal guards", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it(
    "GET /wallet auto-provisions a trading wallet and returns it even with balances " +
      "unreachable (this sandbox blocks Solana RPC egress — see lib/solana.ts's null fallback)",
    async () => {
      const identity = createIdentity();
      const { accessToken, user } = await loginOk(app, identity);

      const res = await app.inject({ method: "GET", url: "/wallet", headers: authHeader(accessToken) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.publicKey).toBeTruthy();
      expect(body.custody).toBe("GENERATED");
      // Not asserting solBalance/pabloBalance are null: a real deployment
      // with RPC access would get real numbers here. Both are >=0 or null,
      // never throw — that's the only thing this environment can verify.

      const dbWallet = await prisma.tradingWallet.findUniqueOrThrow({ where: { userId: user.id } });
      expect(dbWallet.encryptedPrivateKey).not.toContain(dbWallet.publicKey);
    },
  );

  it("GET /wallet is idempotent — a second call reuses the same generated wallet", async () => {
    const identity = createIdentity();
    const { accessToken } = await loginOk(app, identity);

    const first = await app.inject({ method: "GET", url: "/wallet", headers: authHeader(accessToken) });
    const second = await app.inject({ method: "GET", url: "/wallet", headers: authHeader(accessToken) });
    expect(first.json().publicKey).toBe(second.json().publicKey);
  });

  it("POST /wallet/withdraw is blocked while the bot is active (409) — checked before touching RPC", async () => {
    const identity = createIdentity();
    const { accessToken, user } = await loginOk(app, identity);

    await prisma.botSettings.upsert({
      where: { userId: user.id },
      create: { userId: user.id, isActive: true },
      update: { isActive: true },
    });

    const res = await app.inject({
      method: "POST",
      url: "/wallet/withdraw",
      headers: authHeader(accessToken),
      payload: { toAddress: "x".repeat(40), amountSol: 0.01 },
    });
    expect(res.statusCode).toBe(409);
  });

  it("POST /wallet/withdraw rejects an invalid destination address (400) — also checked before touching RPC", async () => {
    const identity = createIdentity();
    const { accessToken } = await loginOk(app, identity);
    // Provision the trading wallet first so we reach the address-parsing
    // check rather than an earlier 404.
    await app.inject({ method: "GET", url: "/wallet", headers: authHeader(accessToken) });

    const res = await app.inject({
      method: "POST",
      url: "/wallet/withdraw",
      headers: authHeader(accessToken),
      payload: { toAddress: "x".repeat(40), amountSol: 0.01 },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /wallet/withdraw is rate-limited past its configured ceiling of 5/min", async () => {
    const identity = createIdentity();
    const { accessToken } = await loginOk(app, identity);
    await app.inject({ method: "GET", url: "/wallet", headers: authHeader(accessToken) });

    const requests = Array.from({ length: 6 }, () =>
      app.inject({
        method: "POST",
        url: "/wallet/withdraw",
        headers: authHeader(accessToken),
        payload: { toAddress: "x".repeat(40), amountSol: 0.01 },
      }),
    );
    const results = await Promise.all(requests);
    expect(results.some((r) => r.statusCode === 429)).toBe(true);
  });
});
