import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_ORIGIN: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("30d"),
  RPC_HTTP: z.string().url(),
  ENGINE_BRIDGE_INTERNAL_TOKEN: z.string().min(1),

  // Bootstrap defaults only — used to seed the single PlatformConfig row the
  // first time the app runs against an empty database. After that, the DB
  // (admin-editable) is the source of truth; these env vars are never read
  // again. See src/modules/admin/platform-config.service.ts.
  TREASURY_WALLET_ADDRESS: z.string().optional(),
  PABLO_MINT_ADDRESS: z.string().optional(),
  MIN_HOLDER_TOKENS: z.coerce.number().int().positive().default(1_000_000),
  SUBSCRIPTION_PRICE_USD: z.coerce.number().positive().default(10),
  SUBSCRIPTION_DURATION_DAYS: z.coerce.number().int().positive().default(30),
  GRACE_PERIOD_DAYS: z.coerce.number().int().nonnegative().default(3),

  // Comma-separated wallet addresses auto-promoted to ADMIN on login —
  // bootstraps the first admin without needing direct DB access.
  ADMIN_WALLET_ADDRESSES: z.string().optional(),

  // Envelope key for trading-wallet secret keys (AES-256-GCM, base64,
  // 32 bytes). This is the placeholder-for-KMS referenced throughout —
  // swap for real KMS/Vault before production, see wallet.service.ts.
  WALLET_ENCRYPTION_KEY: z.string().min(1),

  // engine-bridge (the orchestrator) and the platform-wide chain
  // infrastructure it needs to hand each executor at spawn time. Not
  // admin-editable like PlatformConfig — these are ops/infra credentials,
  // not product settings.
  ENGINE_BRIDGE_URL: z.string().url().default("http://localhost:8090"),
  YELLOWSTONE_GRPC_HTTP: z.string().default("https://not-configured.invalid"),
  YELLOWSTONE_GRPC_TOKEN: z.string().default("not-configured"),
  ZERO_SLOT_URL: z.string().default("https://not-configured.invalid"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
