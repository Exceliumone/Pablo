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
