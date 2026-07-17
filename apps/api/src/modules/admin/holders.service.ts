import type { AdminHolderDto } from "@pablo/shared-types";
import { prisma } from "../../lib/prisma.js";
import { humanTokensToRaw, rawToHumanString } from "../../lib/solana.js";
import { getPlatformConfig } from "./platform-config.service.js";

export interface ListHoldersOptions {
  cursor?: string;
  limit: number;
}

/**
 * Reads the last-persisted HolderSnapshot rows rather than checking live
 * balances — holder.service.ts's checkHolderStatus already does a live RPC
 * call per linked wallet on every reconciliation (login, subscription
 * fetch, the periodic sweep), so re-checking every wallet again just to
 * render this list would be a redundant N-wallet RPC fan-out on every page
 * load. This is a monitoring view of what's already been observed, not a
 * live probe.
 */
export async function listHolders(opts: ListHoldersOptions) {
  const users = await prisma.user.findMany({
    where: { wallets: { some: {} } },
    orderBy: { createdAt: "desc" },
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    include: { wallets: true },
  });

  const hasMore = users.length > opts.limit;
  const page = hasMore ? users.slice(0, opts.limit) : users;
  const lastRow = page.at(-1);

  const userIds = page.map((u) => u.id);
  const snapshots = userIds.length
    ? await prisma.holderSnapshot.findMany({
        where: { userId: { in: userIds } },
        orderBy: { checkedAt: "desc" },
      })
    : [];

  // First occurrence per (userId, walletAddress) is the most recent, since
  // snapshots are already ordered by checkedAt desc.
  const latestByUserWallet = new Map<string, (typeof snapshots)[number]>();
  for (const s of snapshots) {
    const key = `${s.userId}:${s.walletAddress}`;
    if (!latestByUserWallet.has(key)) latestByUserWallet.set(key, s);
  }

  const config = await getPlatformConfig();
  let requiredRaw: bigint | null = null;
  let mintAddress: string | null = null;
  try {
    requiredRaw = await humanTokensToRaw(config.pabloMintAddress, config.minHolderTokens);
    mintAddress = config.pabloMintAddress;
  } catch {
    // Mint decimals lookup needs RPC — leave requiredRaw null and report
    // balances without a computed meetsThreshold rather than fail the page.
  }

  const holders: AdminHolderDto[] = await Promise.all(
    page.map(async (u) => {
      const primary = u.wallets.find((w) => w.isPrimary) ?? u.wallets[0];
      const relevant = [...latestByUserWallet.values()].filter((s) => s.userId === u.id);

      if (relevant.length === 0) {
        return {
          userId: u.id,
          primaryWallet: primary?.address ?? null,
          balanceRaw: null,
          balanceHuman: null,
          meetsThreshold: null,
          checkedAt: null,
        };
      }

      const balanceRaw = relevant.reduce((sum, s) => sum + s.balance, 0n);
      const checkedAt = new Date(Math.max(...relevant.map((s) => s.checkedAt.getTime())));

      let balanceHuman: string | null = null;
      if (mintAddress) {
        balanceHuman = await rawToHumanString(mintAddress, balanceRaw).catch(() => null);
      }

      return {
        userId: u.id,
        primaryWallet: primary?.address ?? null,
        balanceRaw: balanceRaw.toString(),
        balanceHuman,
        meetsThreshold: requiredRaw !== null ? balanceRaw >= requiredRaw : null,
        checkedAt: checkedAt.toISOString(),
      };
    }),
  );

  return { holders, nextCursor: hasMore && lastRow ? lastRow.id : null };
}
