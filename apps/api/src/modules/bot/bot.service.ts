import type { BotSettingsDto } from "@pablo/shared-types";
import { prisma } from "../../lib/prisma.js";
import { env } from "../../config/env.js";
import {
  startExecutor,
  stopExecutor,
  getExecutorStatus,
  sellPosition,
} from "../../lib/engine-bridge-client.js";
import { decryptTradingWalletSecret, getOrCreateTradingWallet } from "../wallet/wallet.service.js";
import { trackWalletsForUser, untrackWalletsForUser } from "../../lib/tracked-wallets.js";

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

// A priority fee bigger than this fraction of the buy amount itself is
// never a deliberate choice — it means the position is guaranteed to
// lose money to fees alone before the token even has a chance to move
// (observed live: a user lowered amountPerBuySol to 0.001 SOL for small
// tests but left priorityFeeLamports at 3_000_000 (0.003 SOL) — a fee 3x
// bigger than the entire trade, on every single buy). Neither field is
// validated against the other by botSettingsSchema alone since a PATCH
// can touch just one of them, so this checks the fully-merged resolved
// row instead, right before it's persisted.
const MAX_PRIORITY_FEE_FRACTION_OF_BUY = 0.5;

async function assertSanePriorityFee(amountPerBuySol: number, priorityFeeLamports: bigint) {
  const buyLamports = BigInt(Math.round(amountPerBuySol * 1_000_000_000));
  if (buyLamports <= 0n) return;
  // fee > MAX_PRIORITY_FEE_FRACTION_OF_BUY * buyLamports, done as an
  // integer comparison (fee * 2 > buyLamports, since the fraction is 1/2)
  // to avoid float precision issues on the bigint side.
  if (priorityFeeLamports * 2n > buyLamports) {
    const priorityFeeSol = Number(priorityFeeLamports) / 1_000_000_000;
    throw new BotError(
      `Le priority fee (${priorityFeeSol.toFixed(4)} SOL) dépasse ${Math.round(MAX_PRIORITY_FEE_FRACTION_OF_BUY * 100)}% du montant par achat (${amountPerBuySol.toFixed(4)} SOL) — cette combinaison garantit de perdre de l'argent en frais sur chaque trade. Augmentez le montant par achat ou réduisez le priority fee.`,
      422,
    );
  }
}

export async function updateBotSettings(userId: string, patch: Partial<BotSettingsDto>) {
  const data = toPrismaPatch(patch);
  const existing = await prisma.botSettings.findUnique({ where: { userId } });
  const resolvedAmountPerBuySol = patch.amountPerBuySol ?? existing?.amountPerBuySol ?? 0.05;
  const resolvedPriorityFeeLamports = data.priorityFeeLamports ?? existing?.priorityFeeLamports ?? 2_000_000n;
  await assertSanePriorityFee(resolvedAmountPerBuySol, resolvedPriorityFeeLamports);

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

/** Shared by startBot and closePositionManually — both need the exact same
 * wallet+RPC+settings shape the executor expects, freshly built (never
 * cached/reused across requests) since it carries a decrypted wallet
 * secret. */
async function buildExecutorPayload(userId: string, settings: BotSettingsRow) {
  const secretKeyB58 = await decryptTradingWalletSecret(userId);

  // Without this, a freshly (re)started executor's in-memory position
  // tracking starts completely empty and a position bought by a previous
  // process instance (e.g. before a crash+auto-restart) never gets
  // take-profit/stop-loss/trailing monitoring again — see
  // engine-bridge-client.ts's OpenPositionSeed doc comment.
  const openPositions = await prisma.position.findMany({
    where: { userId, status: "OPEN" },
    select: { tokenMint: true, currentAmount: true, entryPriceSol: true, costBasisSol: true },
  });

  return {
    user_id: userId,
    wallet_secret_key_b58: secretKeyB58,
    rpc_http: env.RPC_HTTP,
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
    open_positions: openPositions.map((p) => ({
      mint: p.tokenMint,
      amount_token: p.currentAmount,
      entry_price_sol: p.entryPriceSol,
      cost_basis_sol: p.costBasisSol,
    })),
  };
}

/** "Close Position" — force-sells 100% of whatever this wallet actually
 * holds for `mint` right now, via engine-bridge's /sell endpoint, which
 * routes into the already-running executor if there is one, or spawns a
 * one-shot process otherwise. Doesn't require an active subscription
 * (unlike startBot) — a user shouldn't be locked out of recovering a stuck
 * position just because their Premium lapsed. */
export async function closePositionManually(userId: string, mint: string) {
  const settings = await prisma.botSettings.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
  const payload = await buildExecutorPayload(userId, settings);
  await sellPosition(userId, mint, payload);
}

export async function startBot(userId: string) {
  await requireActiveSubscription(userId);

  const [settings, wallet] = await Promise.all([
    prisma.botSettings.upsert({ where: { userId }, create: { userId }, update: {} }),
    getOrCreateTradingWallet(userId),
  ]);
  const payload = await buildExecutorPayload(userId, settings);

  await prisma.botSettings.update({ where: { userId }, data: { isActive: true } });

  // The scanner is a copy-trading wallet tracker, not a DEX-wide sniper
  // feed (see apps/engine-bridge/src/bin/scanner.rs's module doc) — it
  // only ever watches wallets registered here. Register this user's full,
  // current target list (or nothing, if copy-trading is off) *before*
  // spawning the executor, so the scanner has a chance to pick up the new
  // wallet on its next tracked-wallet poll instead of racing the executor
  // itself. Also re-run on every settings update applied to a running bot
  // (updateBotSettings calls startBot again below) — this always fully
  // replaces this user's previous set rather than merging into it, so a
  // removed target wallet is correctly no longer tracked once this runs.
  await trackWalletsForUser(
    userId,
    settings.copyTradingEnabled ? settings.copyTradingTargets : [],
  );

  const status = await startExecutor(payload);

  return { status, walletPublicKey: wallet.publicKey };
}

export async function stopBot(userId: string) {
  await prisma.botSettings.updateMany({ where: { userId }, data: { isActive: false } });
  await untrackWalletsForUser(userId);
  return stopExecutor(userId);
}

export async function getBotStatus(userId: string) {
  return getExecutorStatus(userId);
}
