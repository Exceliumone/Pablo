import { Connection, PublicKey } from "@solana/web3.js";
import BigNumber from "bignumber.js";
import { env } from "../config/env.js";
import { redis } from "./redis.js";

export const connection = new Connection(env.RPC_HTTP, "confirmed");

const SOL_PRICE_CACHE_KEY = "price:sol-usd";
const SOL_PRICE_TTL_SECONDS = 60;

/**
 * SOL/USD from CoinGecko (same source the trading engine already uses as
 * its fallback, see engine/src/common/config.rs::create_coingecko_proxy),
 * cached in Redis so a burst of payment-intent requests doesn't hammer the
 * free API tier or make a lapsed price swing what a user owes mid-checkout.
 */
export async function getSolUsdPrice(): Promise<number> {
  const cached = await redis.get(SOL_PRICE_CACHE_KEY);
  if (cached) return Number(cached);

  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  );
  if (!res.ok) {
    throw new Error(`CoinGecko price fetch failed: ${res.status}`);
  }
  const body = (await res.json()) as { solana: { usd: number } };
  const price = body.solana.usd;

  await redis.set(SOL_PRICE_CACHE_KEY, price.toString(), "EX", SOL_PRICE_TTL_SECONDS);
  return price;
}

const mintDecimalsCache = new Map<string, number>();

async function getMintDecimals(mint: PublicKey): Promise<number> {
  const key = mint.toBase58();
  const cached = mintDecimalsCache.get(key);
  if (cached !== undefined) return cached;

  const supply = await connection.getTokenSupply(mint);
  const decimals = supply.value.decimals;
  mintDecimalsCache.set(key, decimals);
  return decimals;
}

/**
 * Raw on-chain balance of `mint` held by `ownerAddress`, summed across all
 * of that owner's token accounts for the mint (there's usually just one,
 * but nothing guarantees it). Returns 0 for an invalid/unfunded owner
 * rather than throwing — a wallet that's never touched $PABLO is not an
 * error case, it's just a zero balance.
 */
export async function getTokenBalanceRaw(
  ownerAddress: string,
  mintAddress: string,
): Promise<bigint> {
  const owner = new PublicKey(ownerAddress);
  const mint = new PublicKey(mintAddress);

  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint });

  let total = 0n;
  for (const { account } of accounts.value) {
    const amount = account.data.parsed?.info?.tokenAmount?.amount as string | undefined;
    if (amount) total += BigInt(amount);
  }
  return total;
}

/** `minHolderTokens` in PlatformConfig is a human token count (e.g. 1,000,000
 * $PABLO) — this converts it to raw base units using the mint's decimals so
 * it can be compared against getTokenBalanceRaw's output. */
export async function humanTokensToRaw(mintAddress: string, humanAmount: bigint): Promise<bigint> {
  const decimals = await getMintDecimals(new PublicKey(mintAddress));
  return humanAmount * 10n ** BigInt(decimals);
}

/** Inverse of humanTokensToRaw — formats a raw base-unit amount back to a
 * human-readable token count string, for display purposes only. */
export async function rawToHumanString(mintAddress: string, raw: bigint): Promise<string> {
  const decimals = await getMintDecimals(new PublicKey(mintAddress));
  return new BigNumber(raw.toString()).dividedBy(new BigNumber(10).pow(decimals)).toFixed(0);
}
