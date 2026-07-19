import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { WalletDto, WithdrawalQuoteDto } from "@pablo/shared-types";
import { prisma } from "../../lib/prisma.js";
import { encryptSecret, decryptSecret } from "../../lib/wallet-crypto.js";
import { connection, getTokenBalanceRaw, rawToHumanString } from "../../lib/solana.js";
import { getPlatformConfig } from "../admin/platform-config.service.js";
import { logAudit } from "../../lib/audit.js";

export class WalletError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

// A flat, generic fee estimate for the rare case getFeeForMessage returns
// null (RPC that doesn't support it) — matches Solana's normal one-signature
// base fee, so this only ever under- rather than over-reserves.
const FALLBACK_NETWORK_FEE_LAMPORTS = 5000;

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
 * Lets a user recover their own custodial trading wallet's private key —
 * e.g. to move funds out independently if the bot or this platform is
 * ever unavailable. Returns the same base58 secret `decryptTradingWalletSecret`
 * already decrypts for internal use (building the executor's config); this
 * is simply the first caller that returns it in an HTTP response instead
 * of consuming it server-side only, so every export is logged via
 * `logAudit` for a durable, queryable trail of when this ever happened —
 * this can't be undone or revoked (the wallet would need to be rotated,
 * not built here yet), so the record matters even though the export
 * itself can't be blocked after the fact.
 */
export async function exportTradingWalletPrivateKey(
  userId: string,
): Promise<{ publicKey: string; secretKeyB58: string }> {
  const wallet = await prisma.tradingWallet.findUnique({ where: { userId } });
  if (!wallet) {
    throw new WalletError("No trading wallet provisioned for this user yet.", 404);
  }
  const secretKeyB58 = await decryptTradingWalletSecret(userId);

  await logAudit({
    actorType: "USER",
    actorUserId: userId,
    action: "wallet.export_private_key",
  });

  return { publicKey: wallet.publicKey, secretKeyB58 };
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
 * The real, on-chain-derived numbers behind "how much can I withdraw" —
 * the wallet's actual rent-exempt minimum (`getMinimumBalanceForRentExemption`,
 * not a guessed constant) plus this transfer's actual estimated network fee
 * (`getFeeForMessage` against a real probe transaction). Used both to show
 * the user a real max/fee breakdown before they submit, and to validate the
 * withdrawal server-side — so the two never disagree the way a UI-only
 * balance and a hardcoded backend reserve used to.
 */
export async function getWithdrawalQuote(userId: string): Promise<WithdrawalQuoteDto> {
  const wallet = await getOrCreateTradingWallet(userId);
  const pubkey = new PublicKey(wallet.publicKey);

  const [balanceLamports, rentExemptReserveLamports, { blockhash }] = await Promise.all([
    connection.getBalance(pubkey),
    connection.getMinimumBalanceForRentExemption(0),
    connection.getLatestBlockhash(),
  ]);

  const probeTx = new Transaction({ feePayer: pubkey, recentBlockhash: blockhash }).add(
    SystemProgram.transfer({ fromPubkey: pubkey, toPubkey: pubkey, lamports: 0 }),
  );
  const feeResult = await connection.getFeeForMessage(probeTx.compileMessage());
  const networkFeeLamports = feeResult.value ?? FALLBACK_NETWORK_FEE_LAMPORTS;

  const maxWithdrawableLamports = Math.max(
    0,
    balanceLamports - rentExemptReserveLamports - networkFeeLamports,
  );

  return {
    balanceSol: balanceLamports / LAMPORTS_PER_SOL,
    networkFeeSol: networkFeeLamports / LAMPORTS_PER_SOL,
    rentExemptReserveSol: rentExemptReserveLamports / LAMPORTS_PER_SOL,
    maxWithdrawableSol: maxWithdrawableLamports / LAMPORTS_PER_SOL,
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

  const quote = await getWithdrawalQuote(userId);
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  const maxWithdrawableLamports = Math.round(quote.maxWithdrawableSol * LAMPORTS_PER_SOL);
  if (lamports > maxWithdrawableLamports) {
    throw new WalletError(
      `Amount exceeds the withdrawable balance. Max withdrawable is ${quote.maxWithdrawableSol.toFixed(6)} SOL ` +
        `(a ${quote.rentExemptReserveSol.toFixed(6)} SOL rent-exempt reserve and ` +
        `~${quote.networkFeeSol.toFixed(6)} SOL network fee are kept back).`,
      400,
    );
  }

  const secretB58 = await decryptTradingWalletSecret(userId);
  const keypair = Keypair.fromSecretKey(bs58.decode(secretB58));

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
