import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { WalletDto } from "@pablo/shared-types";
import { prisma } from "../../lib/prisma.js";
import { encryptSecret, decryptSecret } from "../../lib/wallet-crypto.js";
import { connection, getTokenBalanceRaw, rawToHumanString } from "../../lib/solana.js";
import { getPlatformConfig } from "../admin/platform-config.service.js";

export class WalletError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

// Leave the account rent-exempt and with a little headroom for the network
// fee on this and the bot's own next trade — a withdrawal can't drain the
// wallet to exactly zero.
const MIN_REMAINING_LAMPORTS = 0.01 * LAMPORTS_PER_SOL;

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

/**
 * Balances are best-effort: this sandbox's network policy blocks Solana
 * RPC, so both come back `null` here rather than throwing — the wallet
 * page should render the address either way. A real deployment with RPC
 * access gets real numbers.
 */
export async function getWalletView(userId: string): Promise<WalletDto> {
  const wallet = await getOrCreateTradingWallet(userId);
  const pubkey = new PublicKey(wallet.publicKey);

  let solBalance: number | null = null;
  try {
    const lamports = await connection.getBalance(pubkey);
    solBalance = lamports / LAMPORTS_PER_SOL;
  } catch {
    solBalance = null;
  }

  let pabloBalance: string | null = null;
  try {
    const config = await getPlatformConfig();
    const raw = await getTokenBalanceRaw(wallet.publicKey, config.pabloMintAddress);
    pabloBalance = await rawToHumanString(config.pabloMintAddress, raw);
  } catch {
    pabloBalance = null;
  }

  return {
    publicKey: wallet.publicKey,
    custody: wallet.custody,
    solBalance,
    pabloBalance,
  };
}

/**
 * Sends SOL out of the custodial trading wallet to a user-specified
 * address. Blocked while the bot is running: the executor holds its own
 * long-lived RPC connection and signs with this same key, and racing a
 * manual transfer against an in-flight trade is exactly the kind of bug
 * that's cheap to prevent and expensive to debug after the fact — stop the
 * bot first.
 */
export async function withdrawFromTradingWallet(
  userId: string,
  toAddress: string,
  amountSol: number,
): Promise<string> {
  const botSettings = await prisma.botSettings.findUnique({ where: { userId } });
  if (botSettings?.isActive) {
    throw new WalletError("Stop the bot before withdrawing from the trading wallet.", 409);
  }

  const wallet = await prisma.tradingWallet.findUnique({ where: { userId } });
  if (!wallet) {
    throw new WalletError("No trading wallet provisioned for this user yet.", 404);
  }

  let destination: PublicKey;
  try {
    destination = new PublicKey(toAddress);
  } catch {
    throw new WalletError("Invalid destination address.", 400);
  }

  const secretB58 = await decryptTradingWalletSecret(userId);
  const keypair = Keypair.fromSecretKey(bs58.decode(secretB58));

  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  const balance = await connection.getBalance(keypair.publicKey);
  if (lamports + MIN_REMAINING_LAMPORTS > balance) {
    throw new WalletError(
      "Amount exceeds the withdrawable balance (a small buffer is kept for rent and fees).",
      400,
    );
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: destination,
      lamports,
    }),
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [keypair]);
  return signature;
}
