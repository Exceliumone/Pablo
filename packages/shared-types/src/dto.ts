import { z } from "zod";
import {
  NOTIFICATION_TYPES,
  POSITION_STATUSES,
  PROTOCOLS,
  SUBSCRIPTION_SOURCES,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_TIERS,
  TRADE_SIDES,
  TRADE_STATUSES,
  USER_ROLES,
  USER_STATUSES,
} from "./enums.js";

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
  role: z.enum(USER_ROLES),
  status: z.enum(USER_STATUSES),
  wallets: z.array(walletLinkDto),
  subscription: z
    .object({
      tier: z.enum(SUBSCRIPTION_TIERS),
      status: z.enum(SUBSCRIPTION_STATUSES),
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
  tier: z.enum(SUBSCRIPTION_TIERS),
  status: z.enum(SUBSCRIPTION_STATUSES),
  source: z.enum(SUBSCRIPTION_SOURCES).nullable(),
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
  // A number, not a serialized bigint like minHolderTokens/amountLamports
  // elsewhere — priority fees are always small (well under
  // Number.MAX_SAFE_INTEGER even at many SOL), so there's no precision
  // reason to pay the bigint-as-string tax here.
  priorityFeeLamports: z.number().int().nonnegative(),
  slippageBps: z.number().int().min(0).max(10000),
  autoSell: z.boolean(),
  copyTradingEnabled: z.boolean(),
  copyTradingTargets: z.array(z.string()),
  protocolPreference: z.enum(PROTOCOLS),
});
export type BotSettingsDto = z.infer<typeof botSettingsSchema>;

// ─────────────────────────────────────────────────────────────────
// Bot control plane — the contract between apps/api and the engine
// control layer (apps/engine-bridge). Any engine implementation that
// speaks this contract (HTTP for control, these payloads over the
// executor:events:<userId> Redis channel for live events) is a valid
// drop-in replacement — apps/api and apps/web never assume anything
// about the engine beyond this shape. See docs/ARCHITECTURE.md §"Engine
// contract".
// ─────────────────────────────────────────────────────────────────

export const BOT_STATUSES = ["STOPPED", "STARTING", "RUNNING", "STOPPING", "ERROR"] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];

export const botStatusDto = z.object({
  status: z.enum(BOT_STATUSES),
  pid: z.number().nullable(),
  startedAt: z.string().datetime().nullable(),
  lastEventAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  restartCount: z.number().int().nonnegative(),
});
export type BotStatusDto = z.infer<typeof botStatusDto>;

export const botEventDto = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("status"),
    userId: z.string(),
    status: z.enum(BOT_STATUSES),
    at: z.string().datetime(),
  }),
  z.object({
    type: z.literal("opportunity"),
    userId: z.string(),
    mint: z.string(),
    dex: z.string(),
    priceSol: z.number(),
    liquiditySol: z.number(),
    at: z.string().datetime(),
  }),
  z.object({
    type: z.literal("trade"),
    userId: z.string(),
    side: z.enum(TRADE_SIDES),
    mint: z.string(),
    dex: z.string(),
    priceSol: z.number(),
    // Both are estimates on a sell (tick price × tracked position size) —
    // the engine returns no fill data. Exact on a buy (the configured
    // spend). See the Trade model doc comment in prisma/schema.prisma.
    amountSol: z.number(),
    amountToken: z.number(),
    txSignature: z.string().nullable(),
    reason: z.string().nullable(),
    at: z.string().datetime(),
  }),
  z.object({
    type: z.literal("error"),
    userId: z.string(),
    message: z.string(),
    at: z.string().datetime(),
  }),
]);
export type BotEventDto = z.infer<typeof botEventDto>;

export const tradeDto = z.object({
  id: z.string(),
  tokenMint: z.string(),
  tokenSymbol: z.string().nullable(),
  side: z.enum(TRADE_SIDES),
  protocol: z.string(),
  priceSol: z.number(),
  amountToken: z.number(),
  amountSol: z.number(),
  txSignature: z.string().nullable(),
  status: z.enum(TRADE_STATUSES),
  reason: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type TradeDto = z.infer<typeof tradeDto>;

export const tradesPageDto = z.object({
  trades: z.array(tradeDto),
  nextCursor: z.string().nullable(),
});
export type TradesPageDto = z.infer<typeof tradesPageDto>;

export const notificationDto = z.object({
  id: z.string(),
  type: z.enum(NOTIFICATION_TYPES),
  title: z.string(),
  body: z.string(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type NotificationDto = z.infer<typeof notificationDto>;

export const notificationsPageDto = z.object({
  notifications: z.array(notificationDto),
  nextCursor: z.string().nullable(),
});
export type NotificationsPageDto = z.infer<typeof notificationsPageDto>;

export const positionDto = z.object({
  id: z.string(),
  tokenMint: z.string(),
  tokenSymbol: z.string().nullable(),
  status: z.enum(POSITION_STATUSES),
  entryPriceSol: z.number(),
  currentAmount: z.number(),
  costBasisSol: z.number(),
  realizedPnlSol: z.number(),
  openedAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
});
export type PositionDto = z.infer<typeof positionDto>;

export const portfolioDto = z.object({
  positions: z.array(positionDto),
  summary: z.object({
    openCount: z.number().int().nonnegative(),
    openCostBasisSol: z.number(),
    closedCount: z.number().int().nonnegative(),
    totalRealizedPnlSol: z.number(),
  }),
});
export type PortfolioDto = z.infer<typeof portfolioDto>;

export const analyticsSummaryDto = z.object({
  totalTrades: z.number().int().nonnegative(),
  buyCount: z.number().int().nonnegative(),
  sellCount: z.number().int().nonnegative(),
  closedPositions: z.number().int().nonnegative(),
  winCount: z.number().int().nonnegative(),
  lossCount: z.number().int().nonnegative(),
  winRatePct: z.number().nullable(),
  totalRealizedPnlSol: z.number(),
  bestTradePnlSol: z.number().nullable(),
  worstTradePnlSol: z.number().nullable(),
  avgHoldTimeMinutes: z.number().nullable(),
  pnlByDay: z.array(
    z.object({
      date: z.string(), // YYYY-MM-DD
      realizedPnlSol: z.number(),
    }),
  ),
});
export type AnalyticsSummaryDto = z.infer<typeof analyticsSummaryDto>;

export const walletDto = z.object({
  publicKey: z.string(),
  custody: z.enum(["GENERATED", "IMPORTED"]),
  solBalance: z.number().nullable(), // null when the RPC lookup fails/is unavailable
  pabloBalance: z.string().nullable(), // human-readable string (can exceed Number precision)
});
export type WalletDto = z.infer<typeof walletDto>;

export const withdrawRequestDto = z.object({
  toAddress: z.string().min(32).max(64),
  amountSol: z.number().positive(),
});
export type WithdrawRequestDto = z.infer<typeof withdrawRequestDto>;

export const withdrawResultDto = z.object({
  txSignature: z.string(),
});
export type WithdrawResultDto = z.infer<typeof withdrawResultDto>;

// All amounts in SOL (not lamports) — this is a UI-facing quote, not an
// on-chain payload, so it matches the rest of this file's convention of
// human units for SOL amounts (see e.g. amountPerBuySol above).
export const withdrawalQuoteDto = z.object({
  balanceSol: z.number(),
  networkFeeSol: z.number(),
  rentExemptReserveSol: z.number(),
  maxWithdrawableSol: z.number(),
});
export type WithdrawalQuoteDto = z.infer<typeof withdrawalQuoteDto>;

// Base58 secret key of the custodial trading wallet, decrypted on demand —
// see apps/api's wallet.service.ts exportTradingWalletPrivateKey. Never
// cached or logged; the frontend must clear this from state once the user
// navigates away or hides it.
export const walletExportDto = z.object({
  publicKey: z.string(),
  secretKeyB58: z.string(),
});
export type WalletExportDto = z.infer<typeof walletExportDto>;

// ── Admin console (Phase 6) ────────────────────────────────────────────

export const adminSubscriptionSummaryDto = z.object({
  tier: z.enum(SUBSCRIPTION_TIERS),
  status: z.enum(SUBSCRIPTION_STATUSES),
  source: z.enum(SUBSCRIPTION_SOURCES).nullable(),
  currentPeriodEnd: z.string().datetime().nullable(),
  graceUntil: z.string().datetime().nullable(),
});
export type AdminSubscriptionSummaryDto = z.infer<typeof adminSubscriptionSummaryDto>;

export const adminUserListItemDto = z.object({
  id: z.string(),
  role: z.enum(USER_ROLES),
  status: z.enum(USER_STATUSES),
  createdAt: z.string().datetime(),
  primaryWallet: z.string().nullable(),
  walletCount: z.number().int().nonnegative(),
  subscription: adminSubscriptionSummaryDto,
});
export type AdminUserListItemDto = z.infer<typeof adminUserListItemDto>;

export const adminUsersPageDto = z.object({
  users: z.array(adminUserListItemDto),
  nextCursor: z.string().nullable(),
  totalCount: z.number().int().nonnegative(),
});
export type AdminUsersPageDto = z.infer<typeof adminUsersPageDto>;

export const adminUserDetailDto = z.object({
  id: z.string(),
  role: z.enum(USER_ROLES),
  status: z.enum(USER_STATUSES),
  createdAt: z.string().datetime(),
  email: z.string().nullable(),
  wallets: z.array(walletLinkDto),
  subscription: adminSubscriptionSummaryDto,
  tradingWalletPublicKey: z.string().nullable(),
  botIsActive: z.boolean(),
  totalTrades: z.number().int().nonnegative(),
});
export type AdminUserDetailDto = z.infer<typeof adminUserDetailDto>;

export const adminUserPatchDto = z.object({
  role: z.enum(USER_ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
});
export type AdminUserPatchDto = z.infer<typeof adminUserPatchDto>;

export const adminGrantRequestDto = z.object({
  days: z.number().int().positive().max(3650).default(30),
});
export type AdminGrantRequestDto = z.infer<typeof adminGrantRequestDto>;

export const adminHolderDto = z.object({
  userId: z.string(),
  primaryWallet: z.string().nullable(),
  balanceRaw: z.string().nullable(), // raw base units, serialized bigint; null if never checked
  balanceHuman: z.string().nullable(), // best-effort — null when the mint-decimals RPC lookup is unavailable
  meetsThreshold: z.boolean().nullable(), // null when unknown (never checked, or threshold can't be computed)
  checkedAt: z.string().datetime().nullable(),
});
export type AdminHolderDto = z.infer<typeof adminHolderDto>;

export const adminHoldersPageDto = z.object({
  holders: z.array(adminHolderDto),
  nextCursor: z.string().nullable(),
});
export type AdminHoldersPageDto = z.infer<typeof adminHoldersPageDto>;

export const platformStatsDto = z.object({
  totalUsers: z.number().int().nonnegative(),
  newUsersLast7d: z.number().int().nonnegative(),
  activeSubscriptions: z.number().int().nonnegative(),
  premiumViaPayment: z.number().int().nonnegative(),
  premiumViaHolder: z.number().int().nonnegative(),
  premiumViaAdminGrant: z.number().int().nonnegative(),
  totalTrades: z.number().int().nonnegative(),
  totalBuyVolumeSol: z.number(),
  botsRunning: z.number().int().nonnegative().nullable(), // null when engine-bridge is unreachable
});
export type PlatformStatsDto = z.infer<typeof platformStatsDto>;

export const auditLogDto = z.object({
  id: z.string(),
  actorType: z.string(),
  actorUserId: z.string().nullable(),
  action: z.string(),
  meta: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime(),
});
export type AuditLogDto = z.infer<typeof auditLogDto>;

export const auditLogsPageDto = z.object({
  logs: z.array(auditLogDto),
  nextCursor: z.string().nullable(),
});
export type AuditLogsPageDto = z.infer<typeof auditLogsPageDto>;

export const adminExecutorDto = z.object({
  userId: z.string(),
  status: z.enum(BOT_STATUSES),
  pid: z.number().nullable(),
  startedAt: z.string().datetime().nullable(),
  lastEventAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  restartCount: z.number().int().nonnegative(),
});
export type AdminExecutorDto = z.infer<typeof adminExecutorDto>;

export const adminExecutorsDto = z.object({
  executors: z.array(adminExecutorDto),
  reachable: z.boolean(), // false when engine-bridge itself couldn't be reached
});
export type AdminExecutorsDto = z.infer<typeof adminExecutorsDto>;
