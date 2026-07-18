import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_ORIGIN: z.string().url().default("http://localhost:3000"),
  // The refresh cookie is scoped narrowly (not "/") so it only ever rides
  // along on auth calls — but that scope has to match the path the
  // *browser* actually sees, not apps/api's own internal route prefix.
  // Behind a reverse proxy that strips a prefix before forwarding (e.g.
  // Nginx `location /api/ { proxy_pass http://127.0.0.1:4000/; }`), the
  // browser's request path is /api/auth/..., not /auth/... — a cookie
  // scoped to /auth is then never sent back, silently breaking
  // /auth/refresh (though not /auth/verify itself, which returns its
  // tokens in the JSON body). Set this to match whatever prefix, if any,
  // sits in front of /auth on the public-facing domain.
  AUTH_COOKIE_PATH: z.string().min(1).default("/auth"),
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
  // Optional paid transaction-landing service. Empty by default — PABLO
  // runs entirely on the free public RPC until this is set. An empty
  // string here (relayed through ExecutorStartPayload.zero_slot_url) is
  // what the engine reads as "not configured": it skips ZeroSlot's tip
  // instruction and never asks for ZERO_SLOT_TIP_VALUE or any other
  // ZERO_SLOT_* variable. See engine/src/library/zeroslot.rs.
  ZERO_SLOT_URL: z.string().default(""),
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
