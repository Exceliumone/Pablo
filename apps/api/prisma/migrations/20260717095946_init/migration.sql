-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUBSCRIBER', 'ADMIN', 'SUPPORT');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'BANNED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "TradingWalletCustody" AS ENUM ('GENERATED', 'IMPORTED');

-- CreateEnum
CREATE TYPE "SubTier" AS ENUM ('FREE', 'PREMIUM');

-- CreateEnum
CREATE TYPE "SubSource" AS ENUM ('PAYMENT', 'HOLDER', 'ADMIN_GRANT');

-- CreateEnum
CREATE TYPE "SubStatus" AS ENUM ('ACTIVE', 'GRACE', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TradeSide" AS ENUM ('BUY', 'SELL');

-- CreateEnum
CREATE TYPE "TradeStatus" AS ENUM ('PENDING', 'CONFIRMED', 'FAILED');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "NotifType" AS ENUM ('OPPORTUNITY', 'TRADE_EXECUTED', 'ERROR', 'TAKE_PROFIT', 'STOP_LOSS', 'CONNECTION_LOST', 'BOT_STOPPED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "role" "UserRole" NOT NULL DEFAULT 'SUBSCRIBER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "email" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletLink" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt" TIMESTAMP(3),

    CONSTRAINT "WalletLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradingWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "encryptedPrivateKey" TEXT NOT NULL,
    "kmsKeyId" TEXT NOT NULL,
    "custody" "TradingWalletCustody" NOT NULL DEFAULT 'GENERATED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedAt" TIMESTAMP(3),

    CONSTRAINT "TradingWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tier" "SubTier" NOT NULL DEFAULT 'FREE',
    "source" "SubSource",
    "status" "SubStatus" NOT NULL DEFAULT 'EXPIRED',
    "startedAt" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "graceUntil" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "txSignature" TEXT,
    "fromAddress" TEXT,
    "amountLamports" BIGINT,
    "solUsdPriceAtTx" DOUBLE PRECISION,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "confirmedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HolderSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "balance" BIGINT NOT NULL,
    "meetsThreshold" BOOLEAN NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HolderSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformConfig" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "subscriptionPriceUsd" DOUBLE PRECISION NOT NULL DEFAULT 10,
    "pabloMintAddress" TEXT NOT NULL,
    "minHolderTokens" BIGINT NOT NULL,
    "subscriptionDurationDays" INTEGER NOT NULL DEFAULT 30,
    "gracePeriodDays" INTEGER NOT NULL DEFAULT 3,
    "treasuryWalletAddress" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "PlatformConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhitelistEntry" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhitelistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlacklistEntry" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "reason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlacklistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotSettings" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "amountPerBuySol" DOUBLE PRECISION NOT NULL DEFAULT 0.05,
    "takeProfitPct" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "stopLossPct" DOUBLE PRECISION NOT NULL DEFAULT -20,
    "trailingStopPct" DOUBLE PRECISION,
    "priorityFeeLamports" BIGINT NOT NULL DEFAULT 2000000,
    "slippageBps" INTEGER NOT NULL DEFAULT 1000,
    "autoSell" BOOLEAN NOT NULL DEFAULT true,
    "copyTradingEnabled" BOOLEAN NOT NULL DEFAULT false,
    "copyTradingTargets" TEXT[],
    "protocolPreference" TEXT NOT NULL DEFAULT 'auto',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trade" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "tokenSymbol" TEXT,
    "side" "TradeSide" NOT NULL,
    "protocol" TEXT NOT NULL,
    "priceSol" DOUBLE PRECISION NOT NULL,
    "amountToken" DOUBLE PRECISION NOT NULL,
    "amountSol" DOUBLE PRECISION NOT NULL,
    "txSignature" TEXT NOT NULL,
    "status" "TradeStatus" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Trade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenMint" TEXT NOT NULL,
    "tokenSymbol" TEXT,
    "status" "PositionStatus" NOT NULL DEFAULT 'OPEN',
    "entryPriceSol" DOUBLE PRECISION NOT NULL,
    "currentAmount" DOUBLE PRECISION NOT NULL,
    "costBasisSol" DOUBLE PRECISION NOT NULL,
    "realizedPnlSol" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotifType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "actorType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "WalletLink_address_key" ON "WalletLink"("address");

-- CreateIndex
CREATE INDEX "WalletLink_userId_idx" ON "WalletLink"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TradingWallet_userId_key" ON "TradingWallet"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TradingWallet_publicKey_key" ON "TradingWallet"("publicKey");

-- CreateIndex
CREATE UNIQUE INDEX "Session_refreshToken_key" ON "Session"("refreshToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_referenceId_key" ON "Payment"("referenceId");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_txSignature_key" ON "Payment"("txSignature");

-- CreateIndex
CREATE INDEX "Payment_userId_createdAt_idx" ON "Payment"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "HolderSnapshot_userId_checkedAt_idx" ON "HolderSnapshot"("userId", "checkedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhitelistEntry_address_key" ON "WhitelistEntry"("address");

-- CreateIndex
CREATE UNIQUE INDEX "BlacklistEntry_address_key" ON "BlacklistEntry"("address");

-- CreateIndex
CREATE UNIQUE INDEX "BotSettings_userId_key" ON "BotSettings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Trade_txSignature_key" ON "Trade"("txSignature");

-- CreateIndex
CREATE INDEX "Trade_userId_createdAt_idx" ON "Trade"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Trade_tokenMint_idx" ON "Trade"("tokenMint");

-- CreateIndex
CREATE INDEX "Position_userId_status_idx" ON "Position"("userId", "status");

-- CreateIndex
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "WalletLink" ADD CONSTRAINT "WalletLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TradingWallet" ADD CONSTRAINT "TradingWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HolderSnapshot" ADD CONSTRAINT "HolderSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotSettings" ADD CONSTRAINT "BotSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trade" ADD CONSTRAINT "Trade_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
