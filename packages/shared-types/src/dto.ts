import { z } from "zod";
import { NOTIFICATION_TYPES, PROTOCOLS, TRADE_SIDES, TRADE_STATUSES } from "./enums.js";

// Wire-format DTOs shared between apps/web and apps/api. REST today; the
// same shapes are reused verbatim as WebSocket payloads and, later, as
// protobuf message fields for the internal scanner->executor gRPC path —
// see "API surface" in docs/ARCHITECTURE.md for why these are kept flat and
// transport-agnostic from the start.

export const walletLinkDto = z.object({
  address: z.string(),
  provider: z.string(),
  isPrimary: z.boolean(),
});
export type WalletLinkDto = z.infer<typeof walletLinkDto>;

export const userDto = z.object({
  id: z.string(),
  role: z.enum(["SUBSCRIBER", "ADMIN", "SUPPORT"]),
  status: z.enum(["ACTIVE", "BANNED", "SUSPENDED"]),
  wallets: z.array(walletLinkDto),
  subscription: z
    .object({
      tier: z.enum(["FREE", "PREMIUM"]),
      status: z.enum(["ACTIVE", "GRACE", "EXPIRED"]),
    })
    .nullable(),
});
export type UserDto = z.infer<typeof userDto>;

export const authNonceResponse = z.object({
  message: z.string(),
  nonce: z.string(),
  expiresInSeconds: z.number(),
});
export type AuthNonceResponse = z.infer<typeof authNonceResponse>;

export const authVerifyResponse = z.object({
  accessToken: z.string(),
  user: userDto,
});
export type AuthVerifyResponse = z.infer<typeof authVerifyResponse>;

export const platformConfigDto = z.object({
  subscriptionPriceUsd: z.number().positive(),
  pabloMintAddress: z.string(),
  minHolderTokens: z.string(), // serialized bigint (human token count, not raw units)
  subscriptionDurationDays: z.number().int().positive(),
  gracePeriodDays: z.number().int().nonnegative(),
  treasuryWalletAddress: z.string(),
  updatedAt: z.string().datetime(),
});
export type PlatformConfigDto = z.infer<typeof platformConfigDto>;

export const platformConfigPatchSchema = z.object({
  subscriptionPriceUsd: z.number().positive().optional(),
  pabloMintAddress: z.string().min(32).max(44).optional(),
  minHolderTokens: z.coerce.bigint().positive().optional(),
  subscriptionDurationDays: z.number().int().positive().optional(),
  gracePeriodDays: z.number().int().nonnegative().optional(),
  treasuryWalletAddress: z.string().min(32).max(44).optional(),
});
export type PlatformConfigPatch = z.infer<typeof platformConfigPatchSchema>;

export const subscriptionViewDto = z.object({
  tier: z.enum(["FREE", "PREMIUM"]),
  status: z.enum(["ACTIVE", "GRACE", "EXPIRED"]),
  source: z.enum(["PAYMENT", "HOLDER", "ADMIN_GRANT"]).nullable(),
  currentPeriodEnd: z.string().datetime().nullable(),
  graceUntil: z.string().datetime().nullable(),
  holder: z.object({
    balance: z.string(), // raw base units, serialized bigint
    requiredRaw: z.string(),
    balanceHuman: z.string(),
    requiredHuman: z.string(),
    meetsThreshold: z.boolean(),
  }),
});
export type SubscriptionViewDto = z.infer<typeof subscriptionViewDto>;

export const paymentIntentDto = z.object({
  id: z.string(),
  reference: z.string(),
  recipient: z.string(),
  amountSol: z.number(),
  amountLamports: z.string(),
  solanaPayUrl: z.string(),
  status: z.enum(["PENDING", "CONFIRMED", "FAILED", "EXPIRED"]),
  expiresAt: z.string().datetime(),
});
export type PaymentIntentDto = z.infer<typeof paymentIntentDto>;

export const paymentStatusDto = z.object({
  id: z.string(),
  reference: z.string(),
  amountLamports: z.string(),
  status: z.enum(["PENDING", "CONFIRMED", "FAILED", "EXPIRED"]),
  expiresAt: z.string().datetime(),
  txSignature: z.string().nullable(),
});
export type PaymentStatusDto = z.infer<typeof paymentStatusDto>;

export const botSettingsSchema = z.object({
  isActive: z.boolean(),
  amountPerBuySol: z.number().positive(),
  takeProfitPct: z.number(),
  stopLossPct: z.number(),
  trailingStopPct: z.number().nullable(),
  priorityFeeLamports: z.coerce.bigint(),
  slippageBps: z.number().int().min(0).max(10000),
  autoSell: z.boolean(),
  copyTradingEnabled: z.boolean(),
  copyTradingTargets: z.array(z.string()),
  protocolPreference: z.enum(PROTOCOLS),
});
export type BotSettingsDto = z.infer<typeof botSettingsSchema>;

export const tradeDto = z.object({
  id: z.string(),
  tokenMint: z.string(),
  tokenSymbol: z.string().nullable(),
  side: z.enum(TRADE_SIDES),
  protocol: z.string(),
  priceSol: z.number(),
  amountToken: z.number(),
  amountSol: z.number(),
  txSignature: z.string(),
  status: z.enum(TRADE_STATUSES),
  reason: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type TradeDto = z.infer<typeof tradeDto>;

export const notificationDto = z.object({
  id: z.string(),
  type: z.enum(NOTIFICATION_TYPES),
  title: z.string(),
  body: z.string(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type NotificationDto = z.infer<typeof notificationDto>;
