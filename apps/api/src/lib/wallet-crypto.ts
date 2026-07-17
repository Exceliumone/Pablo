import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

const ALGO = "aes-256-gcm";

/**
 * Envelope encryption placeholder for trading-wallet secret keys. A single
 * symmetric key from env, AES-256-GCM. This is explicitly NOT what should
 * run in production — swap for real KMS/Vault (a per-user data key
 * wrapped by a master key that never leaves the KMS) before handling real
 * funds. Kept deliberately simple for now: the point of this phase is
 * proving the control plane end-to-end, not the key-management hardening
 * that has to happen anyway once $PABLO/real infra exist to test against.
 */
function getKey(): Buffer {
  const key = Buffer.from(env.WALLET_ENCRYPTION_KEY, "base64");
  if (key.length !== 32) {
    throw new Error("WALLET_ENCRYPTION_KEY must decode to exactly 32 bytes (base64)");
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

export function decryptSecret(encoded: string): string {
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}
