import { redis } from "./redis.js";

/**
 * The scanner (apps/engine-bridge/src/bin/scanner.rs, `fetch_tracked_wallets`)
 * is a copy-trading wallet tracker, not a DEX-wide sniper feed: it never
 * subscribes to PumpFun/PumpSwap/Raydium Launchpad program-wide activity,
 * only to the specific wallet addresses in this key — the union, across
 * every user with an active bot and copy-trading enabled, of that user's
 * `copyTradingTargets`. This module is the *only* writer of that state;
 * the scanner only ever reads it.
 */
const GLOBAL_TRACKED_WALLETS_KEY = "scanner:tracked-wallets";

function userTrackedWalletsKey(userId: string): string {
  return `scanner:tracked-wallets:user:${userId}`;
}

/**
 * Registers `wallets` as this user's full, current copy-trading target
 * set, then recomputes the global union the scanner reads. Replaces this
 * user's previous set entirely (not a merge) — call with the complete
 * current target list every time (bot start, or a settings update applied
 * to an already-running bot), so a wallet removed from settings is
 * correctly no longer tracked once this resyncs. Call with an empty array
 * (or use `untrackWalletsForUser`) when copy-trading is disabled or has no
 * targets — a bot with nothing to copy should track nothing.
 */
export async function trackWalletsForUser(userId: string, wallets: string[]): Promise<void> {
  const key = userTrackedWalletsKey(userId);
  const deduped = [...new Set(wallets)];

  const pipeline = redis.pipeline();
  pipeline.del(key);
  if (deduped.length > 0) {
    pipeline.sadd(key, ...deduped);
  }
  await pipeline.exec();

  await recomputeGlobalTrackedWallets();
}

/** Equivalent to `trackWalletsForUser(userId, [])`, named for clarity at
 * call sites that stop tracking entirely (bot stop) rather than update a
 * still-active target list. */
export async function untrackWalletsForUser(userId: string): Promise<void> {
  await redis.del(userTrackedWalletsKey(userId));
  await recomputeGlobalTrackedWallets();
}

/**
 * Rebuilds `scanner:tracked-wallets` (the union the scanner actually
 * reads) from every currently-registered per-user set. Uses SCAN, not
 * KEYS, to enumerate — this only runs on bot start/stop/settings-change
 * (never a request hot path), but KEYS blocks the whole Redis instance
 * for its duration regardless of call frequency, so there's no reason to
 * risk it.
 */
async function recomputeGlobalTrackedWallets(): Promise<void> {
  const userKeys: string[] = [];
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      "scanner:tracked-wallets:user:*",
      "COUNT",
      100,
    );
    cursor = nextCursor;
    userKeys.push(...keys);
  } while (cursor !== "0");

  if (userKeys.length === 0) {
    await redis.del(GLOBAL_TRACKED_WALLETS_KEY);
    return;
  }
  await redis.sunionstore(GLOBAL_TRACKED_WALLETS_KEY, ...userKeys);
}
