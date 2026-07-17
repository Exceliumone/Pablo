import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { prisma } from "../../lib/prisma.js";
import { encryptSecret, decryptSecret } from "../../lib/wallet-crypto.js";

/**
 * The wallet the executor actually trades with — separate from the
 * identity wallet (Phantom/Solflare) used to log in. Auto-generated on
 * first use; importing an existing key (the other option from
 * docs/ARCHITECTURE.md §1 Décision B) is a Phase 4 Wallet-page feature,
 * not built yet — this only covers the GENERATED path.
 */
export async function getOrCreateTradingWallet(userId: string) {
  const existing = await prisma.tradingWallet.findUnique({ where: { userId } });
  if (existing) return existing;

  const keypair = Keypair.generate();
  const publicKey = keypair.publicKey.toBase58();
  const secretB58 = bs58.encode(keypair.secretKey);

  return prisma.tradingWallet.create({
    data: {
      userId,
      publicKey,
      encryptedPrivateKey: encryptSecret(secretB58),
      kmsKeyId: "local-dev-aes-envelope", // placeholder — see wallet-crypto.ts
      custody: "GENERATED",
    },
  });
}

/** Decrypted only transiently, at "start bot" time, to build the payload
 * sent to engine-bridge — never persisted or logged in decrypted form. */
export async function decryptTradingWalletSecret(userId: string): Promise<string> {
  const wallet = await prisma.tradingWallet.findUnique({ where: { userId } });
  if (!wallet) {
    throw new Error("No trading wallet provisioned for this user yet.");
  }
  return decryptSecret(wallet.encryptedPrivateKey);
}
