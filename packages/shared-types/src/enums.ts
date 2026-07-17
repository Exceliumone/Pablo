// Mirrors the Prisma enums in apps/api/prisma/schema.prisma. Kept as plain
// TS unions (not generated) so this package has zero build dependency on
// Prisma — the web app should never need to know about the database.

export const TRADE_SIDES = ["BUY", "SELL"] as const;
export type TradeSide = (typeof TRADE_SIDES)[number];

export const TRADE_STATUSES = ["PENDING", "CONFIRMED", "FAILED"] as const;
export type TradeStatus = (typeof TRADE_STATUSES)[number];

export const POSITION_STATUSES = ["OPEN", "CLOSED"] as const;
export type PositionStatus = (typeof POSITION_STATUSES)[number];

export const NOTIFICATION_TYPES = [
  "OPPORTUNITY",
  "TRADE_EXECUTED",
  "ERROR",
  "TAKE_PROFIT",
  "STOP_LOSS",
  "CONNECTION_LOST",
  "BOT_STOPPED",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const SUBSCRIPTION_SOURCES = ["PAYMENT", "HOLDER", "ADMIN_GRANT"] as const;
export type SubscriptionSource = (typeof SUBSCRIPTION_SOURCES)[number];

export const PROTOCOLS = ["pumpfun", "pumpswap", "raydium", "meteora", "auto"] as const;
export type Protocol = (typeof PROTOCOLS)[number];

export const USER_ROLES = ["SUBSCRIBER", "ADMIN", "SUPPORT"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["ACTIVE", "BANNED", "SUSPENDED"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const SUBSCRIPTION_TIERS = ["FREE", "PREMIUM"] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

export const SUBSCRIPTION_STATUSES = ["ACTIVE", "GRACE", "EXPIRED"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
