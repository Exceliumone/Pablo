import { prisma } from "../../lib/prisma.js";
import { getTokenBalanceRaw, humanTokensToRaw, rawToHumanString } from "../../lib/solana.js";
import { getPlatformConfig } from "../admin/platform-config.service.js";

export interface HolderCheckResult {
  balanceRaw: bigint;
  requiredRaw: bigint;
  balanceHuman: string;
  requiredHuman: string;
  meetsThreshold: boolean;
}

/**
 * Sums $PABLO across every wallet the user has linked (not just the
 * primary one — a holder shouldn't have to consolidate into a single
 * wallet to qualify), snapshots each wallet's balance individually for
 * history/audit, and reports whether the total clears the admin-configured
 * threshold. Does not touch Subscription itself — subscription.service.ts
 * owns turning this into ACTIVE/GRACE/EXPIRED.
 */
export async function checkHolderStatus(userId: string): Promise<HolderCheckResult> {
  const [config, wallets] = await Promise.all([
    getPlatformConfig(),
    prisma.walletLink.findMany({ where: { userId } }),
  ]);

  const requiredRaw = await humanTokensToRaw(config.pabloMintAddress, config.minHolderTokens);

  let balanceRaw = 0n;
  const perWallet: { address: string; balance: bigint }[] = [];

  for (const wallet of wallets) {
    let balance = 0n;
    try {
      balance = await getTokenBalanceRaw(wallet.address, config.pabloMintAddress);
    } catch {
      // An RPC hiccup or an address that somehow isn't a valid pubkey
      // shouldn't fail the whole check — treat that one wallet as 0 and
      // keep going.
    }
    perWallet.push({ address: wallet.address, balance });
    balanceRaw += balance;
  }

  const meetsThreshold = balanceRaw >= requiredRaw;

  if (perWallet.length > 0) {
    await prisma.holderSnapshot.createMany({
      data: perWallet.map((w) => ({
        userId,
        walletAddress: w.address,
        balance: w.balance,
        meetsThreshold: w.balance >= requiredRaw,
      })),
    });
  }

  const [balanceHuman, requiredHuman] = await Promise.all([
    rawToHumanString(config.pabloMintAddress, balanceRaw),
    rawToHumanString(config.pabloMintAddress, requiredRaw),
  ]);

  return { balanceRaw, requiredRaw, balanceHuman, requiredHuman, meetsThreshold };
}
