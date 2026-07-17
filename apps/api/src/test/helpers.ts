import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { buildApp } from "../app.js";
import { prisma } from "../lib/prisma.js";
import type { UserRole, UserStatus } from "@prisma/client";

/**
 * A throwaway ed25519 identity for SIWS tests — the same shape a real
 * wallet extension would hand the frontend, just generated in-process
 * instead of by Phantom/Solflare.
 */
export function createIdentity() {
  const keypair = nacl.sign.keyPair();
  const address = bs58.encode(keypair.publicKey);
  return { keypair, address };
}

export type Identity = ReturnType<typeof createIdentity>;

function signMessage(message: string, identity: Identity): string {
  const signature = nacl.sign.detached(new TextEncoder().encode(message), identity.keypair.secretKey);
  return bs58.encode(signature);
}

const REFRESH_COOKIE = "pablo_refresh";

function extractRefreshCookie(res: LightMyRequestResponse): string {
  const raw = res.cookies.find((c) => c.name === REFRESH_COOKIE);
  if (!raw) {
    throw new Error(`no ${REFRESH_COOKIE} cookie in response (status ${res.statusCode}): ${res.body}`);
  }
  return raw.value;
}

/**
 * Full SIWS round trip against a real running app instance (nonce -> sign
 * -> verify), the same path a browser takes. If a User+WalletLink already
 * exists for this identity's address (see seedUser), login resolves to
 * that existing account and its current role/status — exactly like a
 * returning user.
 */
export async function login(app: FastifyInstance, identity: Identity, provider = "phantom") {
  const nonceRes = await app.inject({ method: "GET", url: `/auth/nonce?address=${identity.address}` });
  if (nonceRes.statusCode !== 200) {
    throw new Error(`nonce request failed (${nonceRes.statusCode}): ${nonceRes.body}`);
  }
  const { message } = nonceRes.json() as { message: string };
  const signature = signMessage(message, identity);

  const verifyRes = await app.inject({
    method: "POST",
    url: "/auth/verify",
    payload: { address: identity.address, signature, provider },
  });

  return verifyRes;
}

/** login() but throws on non-200 and returns the parsed access token/cookie/user directly. */
export async function loginOk(app: FastifyInstance, identity: Identity, provider = "phantom") {
  const res = await login(app, identity, provider);
  if (res.statusCode !== 200) {
    throw new Error(`login failed (${res.statusCode}): ${res.body}`);
  }
  const body = res.json() as { accessToken: string; user: { id: string; role: string } };
  return { accessToken: body.accessToken, refreshToken: extractRefreshCookie(res), user: body.user };
}

export function authHeader(accessToken: string) {
  return { authorization: `Bearer ${accessToken}` };
}

export function cookieHeader(refreshToken: string) {
  return { cookie: `${REFRESH_COOKIE}=${refreshToken}` };
}

/**
 * Pre-seeds a User + primary WalletLink for a given identity, bypassing
 * the nonce/signature dance — used when a test needs a specific starting
 * role/status/subscription *before* the user's first login (e.g. an
 * already-banned account, or an admin without relying on the
 * ADMIN_WALLET_ADDRESSES env var pointing at a keypair we don't hold).
 */
export async function seedUser(opts: {
  identity: Identity;
  role?: UserRole;
  status?: UserStatus;
  subscriptionStatus?: "ACTIVE" | "GRACE" | "EXPIRED";
}) {
  const user = await prisma.user.create({
    data: {
      role: opts.role ?? "SUBSCRIBER",
      status: opts.status ?? "ACTIVE",
      wallets: {
        create: {
          address: opts.identity.address,
          provider: "phantom",
          isPrimary: true,
          lastVerifiedAt: new Date(),
        },
      },
      subscription: {
        create: opts.subscriptionStatus
          ? {
              tier: opts.subscriptionStatus === "EXPIRED" ? "FREE" : "PREMIUM",
              status: opts.subscriptionStatus,
              source: opts.subscriptionStatus === "EXPIRED" ? null : "ADMIN_GRANT",
              currentPeriodEnd:
                opts.subscriptionStatus === "EXPIRED" ? null : new Date(Date.now() + 30 * 86_400_000),
            }
          : {},
      },
      botSettings: { create: {} },
    },
  });
  return user;
}

/** Spins up a real Fastify instance (no HTTP listener — tests talk to it via .inject()). */
export async function buildTestApp() {
  const app = buildApp();
  await app.ready();
  return app;
}
