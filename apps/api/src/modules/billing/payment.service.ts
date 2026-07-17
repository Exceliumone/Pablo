import { Keypair, PublicKey } from "@solana/web3.js";
import {
  encodeURL,
  findReference,
  validateTransfer,
  FindReferenceError,
  ValidateTransferError,
} from "@solana/pay";
import BigNumber from "bignumber.js";
import { PaymentStatus } from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import { connection, getSolUsdPrice } from "../../lib/solana.js";
import { getPlatformConfig } from "../admin/platform-config.service.js";
import { extendPaidPeriod } from "./subscription.service.js";

const INTENT_TTL_MINUTES = 15;
const LAMPORTS_PER_SOL = 1_000_000_000;

export class PaymentError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

export async function createPaymentIntent(userId: string) {
  const config = await getPlatformConfig();
  const solPrice = await getSolUsdPrice();
  const amountSol = config.subscriptionPriceUsd / solPrice;
  const amountLamports = BigInt(Math.ceil(amountSol * LAMPORTS_PER_SOL));

  // A fresh keypair per intent, used purely as a Solana Pay `reference` —
  // it never signs anything, and its private key is discarded immediately;
  // only the public key is stored, as an index to find the payment tx by.
  const reference = Keypair.generate().publicKey;
  const expiresAt = new Date(Date.now() + INTENT_TTL_MINUTES * 60_000);
  const recipient = new PublicKey(config.treasuryWalletAddress);

  const url = encodeURL({
    recipient,
    amount: new BigNumber(amountLamports.toString()).dividedBy(LAMPORTS_PER_SOL),
    reference,
    label: "PABLO Premium",
    message: `PABLO — abonnement Premium (${config.subscriptionDurationDays} jours)`,
  });

  const payment = await prisma.payment.create({
    data: {
      userId,
      referenceId: reference.toBase58(),
      amountLamports,
      solUsdPriceAtTx: solPrice,
      expiresAt,
    },
  });

  return {
    payment,
    solanaPayUrl: url.toString(),
    recipient: config.treasuryWalletAddress,
    amountSol,
  };
}

/**
 * Idempotent: safe to call repeatedly while the frontend polls after the
 * user pays. Returns the payment row as-is if already CONFIRMED, and
 * quietly stays PENDING (no error) if no matching transaction has shown up
 * on-chain yet — that's the normal state right after the wallet submits.
 */
export async function checkPaymentIntent(paymentId: string, userId: string) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.userId !== userId) {
    throw new PaymentError("Payment intent not found.", 404);
  }
  if (payment.status === PaymentStatus.CONFIRMED) {
    return payment;
  }
  if (payment.expiresAt < new Date()) {
    if (payment.status === PaymentStatus.PENDING) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.EXPIRED },
      });
    }
    throw new PaymentError("Payment intent expired — create a new one.", 410);
  }

  const config = await getPlatformConfig();
  const reference = new PublicKey(payment.referenceId);

  let signatureInfo;
  try {
    signatureInfo = await findReference(connection, reference, { finality: "confirmed" });
  } catch (err) {
    if (err instanceof FindReferenceError) {
      return payment; // still pending — no transaction referencing us yet
    }
    throw err;
  }

  try {
    await validateTransfer(connection, signatureInfo.signature, {
      recipient: new PublicKey(config.treasuryWalletAddress),
      amount: new BigNumber(payment.amountLamports!.toString()).dividedBy(LAMPORTS_PER_SOL),
      reference,
    });
  } catch (err) {
    if (err instanceof ValidateTransferError) {
      throw new PaymentError(`On-chain transfer did not match what was requested: ${err.message}`, 402);
    }
    throw err;
  }

  const confirmed = await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: PaymentStatus.CONFIRMED,
      txSignature: signatureInfo.signature,
      confirmedAt: new Date(),
    },
  });

  await extendPaidPeriod(userId, config.subscriptionDurationDays);

  return confirmed;
}
