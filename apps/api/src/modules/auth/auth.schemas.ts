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
  provider: z.enum(["phantom", "solflare", "backpack", "okx", "other"]),
});

export type VerifyBody = z.infer<typeof verifySchema>;
