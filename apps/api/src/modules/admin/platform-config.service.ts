import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { redis } from "../../lib/redis.js";
import { env } from "../../config/env.js";
import { logAudit } from "../../lib/audit.js";

const CACHE_KEY = "platform-config";
const CACHE_TTL_SECONDS = 30;

export class PlatformConfigError extends Error {
  // 503, not 500: "the platform hasn't been configured yet" is an
  // operator-fixable readiness state, not a server bug — see
  // admin.routes.ts's dedicated handler for this class.
  readonly statusCode = 503;
}

/**
 * Row `id: 1` is the entire table — there is exactly one PlatformConfig.
 * On first read against an empty database it's seeded from env bootstrap
 * defaults (see .env.example); every read after that comes from the DB,
 * which is the only thing `PUT /admin/config` ever touches. The env vars
 * are never consulted again once the row exists.
 */
async function getOrSeed() {
  const existing = await prisma.platformConfig.findUnique({ where: { id: 1 } });
  if (existing) return existing;

  if (!env.TREASURY_WALLET_ADDRESS || !env.PABLO_MINT_ADDRESS) {
    throw new PlatformConfigError(
      "PlatformConfig has never been set and TREASURY_WALLET_ADDRESS / PABLO_MINT_ADDRESS " +
        "bootstrap defaults are missing from the environment — set them once to seed the row.",
    );
  }

  try {
    return await prisma.platformConfig.create({
      data: {
        id: 1,
        subscriptionPriceUsd: env.SUBSCRIPTION_PRICE_USD,
        pabloMintAddress: env.PABLO_MINT_ADDRESS,
        minHolderTokens: BigInt(env.MIN_HOLDER_TOKENS),
        subscriptionDurationDays: env.SUBSCRIPTION_DURATION_DAYS,
        gracePeriodDays: env.GRACE_PERIOD_DAYS,
        treasuryWalletAddress: env.TREASURY_WALLET_ADDRESS,
      },
    });
  } catch (err) {
    // Two concurrent first-ever reads can both see no row and both race to
    // seed it — the loser's insert hits the id:1 unique constraint. That's
    // not a real failure, just a lost race: the row it wanted to create
    // already exists, so read it back instead of surfacing an error for
    // what the caller only ever wanted as a read.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return prisma.platformConfig.findUniqueOrThrow({ where: { id: 1 } });
    }
    throw err;
  }
}

export async function getPlatformConfig() {
  const cached = await redis.get(CACHE_KEY);
  if (cached) {
    const parsed = JSON.parse(cached);
    // JSON round-tripped both of these back into plain strings — Date and
    // BigInt need to be reconstructed so a cache hit returns the exact same
    // shape as a cache miss (a fresh Prisma read).
    return { ...parsed, minHolderTokens: BigInt(parsed.minHolderTokens), updatedAt: new Date(parsed.updatedAt) };
  }

  const config = await getOrSeed();
  await redis.set(
    CACHE_KEY,
    JSON.stringify({ ...config, minHolderTokens: config.minHolderTokens.toString() }),
    "EX",
    CACHE_TTL_SECONDS,
  );
  return config;
}

export interface PlatformConfigPatch {
  subscriptionPriceUsd?: number;
  pabloMintAddress?: string;
  minHolderTokens?: bigint;
  subscriptionDurationDays?: number;
  gracePeriodDays?: number;
  treasuryWalletAddress?: string;
}

export async function updatePlatformConfig(adminUserId: string, patch: PlatformConfigPatch) {
  // Deliberately NOT getOrSeed() here: that throws when the env bootstrap
  // vars (TREASURY_WALLET_ADDRESS / PABLO_MINT_ADDRESS) aren't set yet —
  // exactly the situation before $PABLO exists — which used to make this
  // the one endpoint whose entire purpose is setting those values unable
  // to ever run for the first time. Upsert directly instead: an admin
  // supplying real values here IS the seed, env vars are only a
  // convenience default for whatever the patch doesn't cover, falling
  // back to an empty string (not null — the columns are non-nullable) for
  // the two identity fields when neither the patch nor the env has them
  // yet. Downstream Solana calls already degrade gracefully on an empty
  // mint (see wallet.service.ts's getWalletView) or fail with a clear
  // error rather than crash (billing/holder.service.ts) — either way,
  // "not fully configured yet" stays recoverable instead of a dead end.
  const updated = await prisma.platformConfig.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      subscriptionPriceUsd: patch.subscriptionPriceUsd ?? env.SUBSCRIPTION_PRICE_USD,
      pabloMintAddress: patch.pabloMintAddress ?? env.PABLO_MINT_ADDRESS ?? "",
      minHolderTokens: patch.minHolderTokens ?? BigInt(env.MIN_HOLDER_TOKENS),
      subscriptionDurationDays: patch.subscriptionDurationDays ?? env.SUBSCRIPTION_DURATION_DAYS,
      gracePeriodDays: patch.gracePeriodDays ?? env.GRACE_PERIOD_DAYS,
      treasuryWalletAddress: patch.treasuryWalletAddress ?? env.TREASURY_WALLET_ADDRESS ?? "",
      updatedBy: adminUserId,
    },
    update: { ...patch, updatedBy: adminUserId },
  });
  await redis.del(CACHE_KEY);
  await logAudit({
    actorType: "ADMIN",
    actorUserId: adminUserId,
    action: "platform_config.update",
    meta: { ...patch, minHolderTokens: patch.minHolderTokens?.toString() },
  });
  return updated;
}
