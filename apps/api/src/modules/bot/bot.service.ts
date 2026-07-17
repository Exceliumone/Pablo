import type { BotSettingsDto } from "@pablo/shared-types";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import { startExecutor, stopExecutor, getExecutorStatus } from "../../lib/engine-bridge-client.js";
import { decryptTradingWalletSecret, getOrCreateTradingWallet } from "../wallet/wallet.service.js";

export class BotError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

interface BotSettingsRow {
  isActive: boolean;
  amountPerBuySol: number;
  takeProfitPct: number;
  stopLossPct: number;
  trailingStopPct: number | null;
  priorityFeeLamports: bigint;
  slippageBps: number;
  autoSell: boolean;
  copyTradingEnabled: boolean;
  copyTradingTargets: string[];
  protocolPreference: string;
}

function toBotSettingsDto(settings: BotSettingsRow): BotSettingsDto {
  return {
    isActive: settings.isActive,
    amountPerBuySol: settings.amountPerBuySol,
    takeProfitPct: settings.takeProfitPct,
    stopLossPct: settings.stopLossPct,
    trailingStopPct: settings.trailingStopPct,
    // Prisma's BigInt can't cross a Fastify JSON response as-is (native
    // JSON.stringify doesn't know how to serialize BigInt) — priority fees
    // are always small, so a plain number is both safe and simpler for the
    // frontend than the string-encoded-bigint pattern used for token
    // supplies elsewhere.
    priorityFeeLamports: Number(settings.priorityFeeLamports),
    slippageBps: settings.slippageBps,
    autoSell: settings.autoSell,
    copyTradingEnabled: settings.copyTradingEnabled,
    copyTradingTargets: settings.copyTradingTargets,
    protocolPreference: settings.protocolPreference as BotSettingsDto["protocolPreference"],
  };
}

/** Inverse of the above, for writing a partial DTO patch back through Prisma. */
function toPrismaPatch(patch: Partial<BotSettingsDto>) {
  return {
    ...patch,
    priorityFeeLamports:
      patch.priorityFeeLamports === undefined ? undefined : BigInt(patch.priorityFeeLamports),
  };
}

export async function getBotSettings(userId: string) {
  const settings = await prisma.botSettings.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
  return toBotSettingsDto(settings);
}

export async function updateBotSettings(userId: string, patch: Partial<BotSettingsDto>) {
  const data = toPrismaPatch(patch);
  const settings = await prisma.botSettings.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });

  // Applying new settings to an already-running bot means restarting the
  // executor with the fresh payload — the engine only reads its config at
  // boot (see engine/UPSTREAM.md), so there's no live hot-reload to call
  // instead.
  const status = await getExecutorStatus(userId).catch(() => null);
  if (status && (status.status === "RUNNING" || status.status === "STARTING")) {
    await startBot(userId);
  }

  return toBotSettingsDto(settings);
}

async function requireActiveSubscription(userId: string) {
  const subscription = await prisma.subscription.findUnique({ where: { userId } });
  if (!subscription || subscription.status === "EXPIRED") {
    throw new BotError("An active Premium subscription is required to run the bot.", 402);
  }
}

export async function startBot(userId: string) {
  await requireActiveSubscription(userId);

  const [settings, wallet] = await Promise.all([
    prisma.botSettings.upsert({ where: { userId }, create: { userId }, update: {} }),
    getOrCreateTradingWallet(userId),
  ]);
  const secretKeyB58 = await decryptTradingWalletSecret(userId);

  await prisma.botSettings.update({ where: { userId }, data: { isActive: true } });

  const status = await startExecutor({
    user_id: userId,
    wallet_secret_key_b58: secretKeyB58,
    rpc_http: env.RPC_HTTP,
    yellowstone_grpc_http: env.YELLOWSTONE_GRPC_HTTP,
    yellowstone_grpc_token: env.YELLOWSTONE_GRPC_TOKEN,
    zero_slot_url: env.ZERO_SLOT_URL,
    redis_url: env.REDIS_URL,
    settings: {
      amount_per_buy_sol: settings.amountPerBuySol,
      take_profit_pct: settings.takeProfitPct,
      stop_loss_pct: settings.stopLossPct,
      trailing_stop_pct: settings.trailingStopPct,
      priority_fee_lamports: Number(settings.priorityFeeLamports),
      slippage_bps: settings.slippageBps,
      auto_sell: settings.autoSell,
      copy_trading_enabled: settings.copyTradingEnabled,
      copy_trading_targets: settings.copyTradingTargets,
      protocol_preference: settings.protocolPreference,
    },
  });

  return { status, walletPublicKey: wallet.publicKey };
}

export async function stopBot(userId: string) {
  await prisma.botSettings.updateMany({ where: { userId }, data: { isActive: false } });
  return stopExecutor(userId);
}

export async function getBotStatus(userId: string) {
  return getExecutorStatus(userId);
}
