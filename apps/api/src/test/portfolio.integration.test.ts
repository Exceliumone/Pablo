import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { authHeader, buildTestApp, createIdentity, loginOk } from "./helpers.js";

describe("portfolio + trades + analytics: read models over seeded history", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  async function seedHistory(userId: string) {
    await prisma.position.create({
      data: {
        userId,
        tokenMint: "mintOPEN1111111111111111111111111111111",
        status: "OPEN",
        entryPriceSol: 0.001,
        currentAmount: 1000,
        costBasisSol: 1,
      },
    });
    await prisma.position.create({
      data: {
        userId,
        tokenMint: "mintWIN11111111111111111111111111111111",
        status: "CLOSED",
        entryPriceSol: 0.001,
        currentAmount: 0,
        costBasisSol: 1,
        realizedPnlSol: 0.5,
        closedAt: new Date(),
      },
    });
    await prisma.position.create({
      data: {
        userId,
        tokenMint: "mintLOSS1111111111111111111111111111111",
        status: "CLOSED",
        entryPriceSol: 0.002,
        currentAmount: 0,
        costBasisSol: 1,
        realizedPnlSol: -0.3,
        closedAt: new Date(),
      },
    });
    await prisma.trade.createMany({
      data: [
        {
          userId,
          tokenMint: "mintWIN11111111111111111111111111111111",
          side: "BUY",
          protocol: "pumpfun",
          priceSol: 0.001,
          amountToken: 1000,
          amountSol: 1,
          status: "PENDING",
        },
        {
          userId,
          tokenMint: "mintWIN11111111111111111111111111111111",
          side: "SELL",
          protocol: "pumpfun",
          priceSol: 0.0015,
          amountToken: 1000,
          amountSol: 1.5,
          status: "CONFIRMED",
          reason: "TAKE_PROFIT",
        },
      ],
    });
  }

  it("GET /portfolio aggregates open + recent-closed positions with correct summary totals", async () => {
    const identity = createIdentity();
    const { accessToken, user } = await loginOk(app, identity);
    await seedHistory(user.id);

    const res = await app.inject({ method: "GET", url: "/portfolio", headers: authHeader(accessToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.positions).toHaveLength(3);
    expect(body.summary.openCount).toBe(1);
    expect(body.summary.closedCount).toBe(2);
    expect(body.summary.totalRealizedPnlSol).toBeCloseTo(0.2, 5);
  });

  it("GET /trades paginates by cursor and supports filtering by side", async () => {
    const identity = createIdentity();
    const { accessToken, user } = await loginOk(app, identity);
    await seedHistory(user.id);

    const all = await app.inject({ method: "GET", url: "/trades?limit=1", headers: authHeader(accessToken) });
    expect(all.statusCode).toBe(200);
    const firstPage = all.json();
    expect(firstPage.trades).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();

    const buysOnly = await app.inject({
      method: "GET",
      url: "/trades?side=BUY",
      headers: authHeader(accessToken),
    });
    const buyBody = buysOnly.json();
    expect(buyBody.trades).toHaveLength(1);
    expect(buyBody.trades[0].side).toBe("BUY");
  });

  it("a user can never see another user's trades or positions (tenant isolation)", async () => {
    const ownerIdentity = createIdentity();
    const { user: owner } = await loginOk(app, ownerIdentity);
    await seedHistory(owner.id);

    const strangerIdentity = createIdentity();
    const { accessToken: strangerToken } = await loginOk(app, strangerIdentity);

    const portfolio = await app.inject({ method: "GET", url: "/portfolio", headers: authHeader(strangerToken) });
    expect(portfolio.json().positions).toHaveLength(0);

    const trades = await app.inject({ method: "GET", url: "/trades", headers: authHeader(strangerToken) });
    expect(trades.json().trades).toHaveLength(0);
  });

  it("GET /analytics/summary computes win rate, PnL and hold-time stats from closed positions", async () => {
    const identity = createIdentity();
    const { accessToken, user } = await loginOk(app, identity);
    await seedHistory(user.id);

    const res = await app.inject({ method: "GET", url: "/analytics/summary", headers: authHeader(accessToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalTrades).toBe(2);
    expect(body.closedPositions).toBe(2);
    expect(body.winCount).toBe(1);
    expect(body.lossCount).toBe(1);
    expect(body.winRatePct).toBeCloseTo(50, 5);
    expect(body.totalRealizedPnlSol).toBeCloseTo(0.2, 5);
    expect(body.pnlByDay).toHaveLength(14);
  });

  it("GET /analytics/summary reports nulls (not NaN/0) for a user with no closed positions yet", async () => {
    const identity = createIdentity();
    const { accessToken } = await loginOk(app, identity);

    const res = await app.inject({ method: "GET", url: "/analytics/summary", headers: authHeader(accessToken) });
    const body = res.json();
    expect(body.winRatePct).toBeNull();
    expect(body.bestTradePnlSol).toBeNull();
    expect(body.worstTradePnlSol).toBeNull();
    expect(body.avgHoldTimeMinutes).toBeNull();
  });
});
