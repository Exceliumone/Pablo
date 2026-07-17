import { createHash, randomBytes } from "node:crypto";
import bs58 from "bs58";
import { nanoid } from "nanoid";
import nacl from "tweetnacl";
import ms from "ms";
import { prisma } from "../../lib/prisma.js";
import { redis } from "../../lib/redis.js";
import { env } from "../../config/env.js";
import type { VerifyBody } from "./auth.schemas.js";
import { UserRole, UserStatus } from "@prisma/client";

const ADMIN_WALLETS = new Set(
  (env.ADMIN_WALLET_ADDRESSES ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean),
);

const NONCE_TTL_SECONDS = 300;
const NONCE_KEY = (address: string) => `auth:nonce:${address}`;

interface StoredNonce {
  message: string;
  nonce: string;
  issuedAt: string;
}

/**
 * The exact string the wallet is asked to sign. Kept in Redis verbatim
 * (not reconstructed at verify time) so a client can never end up signing
 * a message that doesn't byte-for-byte match what the server checks.
 */
function buildMessage(address: string, nonce: string, issuedAt: string): string {
  return [
    "PABLO wants you to sign in with your Solana account:",
    address,
    "",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join("\n");
}

export async function issueNonce(address: string) {
  const nonce = nanoid(24);
  const issuedAt = new Date().toISOString();
  const message = buildMessage(address, nonce, issuedAt);

  await redis.set(
    NONCE_KEY(address),
    JSON.stringify({ message, nonce, issuedAt } satisfies StoredNonce),
    "EX",
    NONCE_TTL_SECONDS,
  );

  return { message, nonce, expiresInSeconds: NONCE_TTL_SECONDS };
}

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

async function consumeNonce(address: string): Promise<StoredNonce> {
  const key = NONCE_KEY(address);
  const raw = await redis.get(key);
  if (!raw) {
    throw new AuthError("Nonce expired or not found — request a new one.", 400);
  }
  // One-time use: burn it immediately so a captured signature can't be replayed.
  await redis.del(key);
  return JSON.parse(raw) as StoredNonce;
}

function verifySignature(message: string, signatureB58: string, addressB58: string): boolean {
  try {
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signatureB58);
    const publicKeyBytes = bs58.decode(addressB58);
    return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
  } catch {
    return false;
  }
}

interface VerifyResult {
  userId: string;
  role: string;
}

/**
 * Shared by /auth/verify (login, no prior session) and /auth/wallets/link
 * (must already be authenticated). The only branch is what to do once the
 * signature checks out: log in as / create the owning user, or attach the
 * wallet to the already-authenticated one.
 */
export async function verifyAndResolveWallet(
  body: VerifyBody,
  linkingUserId?: string,
): Promise<VerifyResult> {
  const stored = await consumeNonce(body.address);

  if (!verifySignature(stored.message, body.signature, body.address)) {
    throw new AuthError("Signature verification failed.", 401);
  }

  const existingLink = await prisma.walletLink.findUnique({
    where: { address: body.address },
    include: { user: true },
  });

  if (linkingUserId) {
    if (existingLink && existingLink.userId !== linkingUserId) {
      throw new AuthError("This wallet is already linked to another account.", 409);
    }
    if (existingLink) {
      await prisma.walletLink.update({
        where: { address: body.address },
        data: { lastVerifiedAt: new Date() },
      });
      return { userId: existingLink.userId, role: existingLink.user.role };
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: linkingUserId } });
    await prisma.walletLink.create({
      data: {
        userId: linkingUserId,
        address: body.address,
        provider: body.provider,
        isPrimary: false,
        lastVerifiedAt: new Date(),
      },
    });
    return { userId: user.id, role: user.role };
  }

  const shouldBeAdmin = ADMIN_WALLETS.has(body.address);

  if (existingLink) {
    if (existingLink.user.status !== UserStatus.ACTIVE) {
      throw new AuthError("This account is no longer active.", 403);
    }
    await prisma.walletLink.update({
      where: { address: body.address },
      data: { lastVerifiedAt: new Date() },
    });
    if (shouldBeAdmin && existingLink.user.role !== UserRole.ADMIN) {
      const promoted = await prisma.user.update({
        where: { id: existingLink.userId },
        data: { role: UserRole.ADMIN },
      });
      return { userId: promoted.id, role: promoted.role };
    }
    return { userId: existingLink.userId, role: existingLink.user.role };
  }

  const user = await prisma.user.create({
    data: {
      role: shouldBeAdmin ? UserRole.ADMIN : UserRole.SUBSCRIBER,
      wallets: {
        create: {
          address: body.address,
          provider: body.provider,
          isPrimary: true,
          lastVerifiedAt: new Date(),
        },
      },
      subscription: { create: {} },
      botSettings: { create: {} },
    },
  });
  return { userId: user.id, role: user.role };
}

function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  userId: string,
  meta: { userAgent?: string; ip?: string },
) {
  const refreshToken = randomBytes(48).toString("hex");
  const expiresAt = new Date(Date.now() + ms(env.JWT_REFRESH_TTL));

  await prisma.session.create({
    data: {
      userId,
      refreshToken: hashRefreshToken(refreshToken),
      userAgent: meta.userAgent,
      ip: meta.ip,
      expiresAt,
    },
  });

  return { refreshToken, expiresAt };
}

/** Rotates on every refresh: the old session is revoked, a new one issued. */
export async function rotateSession(
  presentedToken: string,
  meta: { userAgent?: string; ip?: string },
) {
  const hashed = hashRefreshToken(presentedToken);
  const session = await prisma.session.findUnique({ where: { refreshToken: hashed } });

  if (!session || session.expiresAt < new Date()) {
    throw new AuthError("Session expired — please sign in again.", 401);
  }

  // Refresh tokens are one-time-use (rotated below). Seeing an
  // already-revoked one presented again means either a client double-fired
  // the request, or someone else got hold of a token that's already been
  // rotated past — a strong theft signal either way. Burn every session
  // for this user rather than just this one, so a stolen-but-already-used
  // token can't be leveraged to keep a stolen session family alive.
  if (session.revokedAt) {
    await prisma.session.updateMany({
      where: { userId: session.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new AuthError("Session expired — please sign in again.", 401);
  }

  await prisma.session.update({
    where: { id: session.id },
    data: { revokedAt: new Date() },
  });

  const user = await prisma.user.findUniqueOrThrow({ where: { id: session.userId } });
  // A banned/suspended user's access tokens still work until they expire
  // (short-lived, ≤15m by default — the same "role change takes effect on
  // next refresh" trust model documented on requireRole), but they can
  // never mint a new one. Combined with revoking every session at the
  // moment an admin sets the status (users.service.ts), this caps a
  // banned user's actual access to whatever access token they already
  // held, not indefinitely.
  if (user.status !== UserStatus.ACTIVE) {
    throw new AuthError("This account is no longer active.", 403);
  }
  const next = await createSession(user.id, meta);
  return { user, ...next };
}

export async function revokeSession(presentedToken: string) {
  const hashed = hashRefreshToken(presentedToken);
  await prisma.session.updateMany({
    where: { refreshToken: hashed, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
