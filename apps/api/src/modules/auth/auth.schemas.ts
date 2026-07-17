import { z } from "zod";

// A Solana base58 address decodes to exactly 32 bytes. Full validity (does it
// lie on the ed25519 curve) is irrelevant here — verifySignature() below
// rejects anything that isn't a genuine keypair anyway.
export const solanaAddressSchema = z
  .string()
  .min(32)
  .max(44)
  .regex(/^[1-9A-HJ-NP-Za-km-z]+$/, "Not a valid base58 Solana address");

export const nonceQuerySchema = z.object({
  address: solanaAddressSchema,
});

export const verifySchema = z.object({
  address: solanaAddressSchema,
  signature: z.string().min(1), // base58-encoded ed25519 signature
  // Free-form on purpose: this records whichever adapter's `name` the
  // frontend reports (Phantom, Solflare, Trust, Bitget, WalletConnect,
  // or any other Wallet-Standard-compliant wallet the browser exposes) —
  // an app-defined closed enum here has to be kept in lockstep with the
  // wallet-adapter list every time one is added or the frontend falls
  // back to a generic label (e.g. "wallet-standard"), and it already
  // stores as a plain string column (WalletLink.provider) and reads back
  // as z.string() (see WalletDto in packages/shared-types/src/dto.ts) —
  // there's no downstream logic that branches on a specific known value.
  provider: z.string().min(1).max(64),
});

export type VerifyBody = z.infer<typeof verifySchema>;
