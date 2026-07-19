import type { BotStatusDto } from "@pablo/shared-types";
import { env } from "../config/env.js";

/**
 * Thin client for the engine-bridge orchestrator's internal API — the one
 * place apps/api knows engine-bridge exists. Everything past this file
 * (routes, the frontend) only knows about BotSettingsDto/BotStatusDto/
 * BotEventDto, never about how the engine is actually run — that's the
 * "engine as an interchangeable plugin" boundary from docs/ARCHITECTURE.md.
 */

export interface ExecutorStartPayload {
  user_id: string;
  wallet_secret_key_b58: string;
  // Standard Solana JSON-RPC HTTP endpoint (the public official RPC by
  // default, or any other free/paid provider) — no Yellowstone gRPC or
  // other paid-provider-specific field: the executor never establishes
  // its own detection subscription, and the scanner is public-RPC-only.
  rpc_http: string;
  zero_slot_url: string;
  redis_url: string;
  settings: {
    amount_per_buy_sol: number;
    take_profit_pct: number;
    stop_loss_pct: number;
    trailing_stop_pct: number | null;
    priority_fee_lamports: number;
    slippage_bps: number;
    auto_sell: boolean;
    copy_trading_enabled: boolean;
    copy_trading_targets: string[];
    protocol_preference: string;
  };
}

class EngineBridgeError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${env.ENGINE_BRIDGE_URL}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${env.ENGINE_BRIDGE_INTERNAL_TOKEN}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new EngineBridgeError(`engine-bridge ${path} -> ${res.status}: ${body}`, res.status);
  }
  return res.json() as Promise<T>;
}

interface RawExecutorView {
  user_id: string;
  status: string;
  pid: number | null;
  started_at: string | null;
  last_event_at: string | null;
  last_error: string | null;
  restart_count: number;
}

function toBotStatusDto(view: RawExecutorView): BotStatusDto {
  return {
    status: view.status as BotStatusDto["status"],
    pid: view.pid,
    startedAt: view.started_at,
    lastEventAt: view.last_event_at,
    lastError: view.last_error,
    restartCount: view.restart_count,
  };
}

export async function startExecutor(payload: ExecutorStartPayload): Promise<BotStatusDto> {
  const view = await request<Parameters<typeof toBotStatusDto>[0]>(
    `/internal/executors/${payload.user_id}/start`,
    { method: "POST", body: JSON.stringify(payload) },
  );
  return toBotStatusDto(view);
}

export async function stopExecutor(userId: string): Promise<BotStatusDto> {
  const view = await request<Parameters<typeof toBotStatusDto>[0]>(
    `/internal/executors/${userId}/stop`,
    { method: "POST" },
  );
  return toBotStatusDto(view);
}

export async function getExecutorStatus(userId: string): Promise<BotStatusDto> {
  const view = await request<Parameters<typeof toBotStatusDto>[0]>(
    `/internal/executors/${userId}`,
  );
  return toBotStatusDto(view);
}

/**
 * "Close Position" — force-sells 100% of whatever this wallet actually
 * holds for `mint`, right now, regardless of what the bot's own
 * take-profit/stop-loss logic thinks. `fallbackPayload` is only used by
 * the orchestrator when this user's executor isn't currently running (see
 * contract.rs's SellPositionRequest doc comment) — always built the same
 * way `startExecutor`'s payload is, from a freshly-decrypted wallet
 * secret, since we can't know here whether it'll actually be needed.
 */
export async function sellPosition(
  userId: string,
  mint: string,
  fallbackPayload: ExecutorStartPayload,
): Promise<void> {
  await request<{ accepted: boolean }>(`/internal/executors/${userId}/sell`, {
    method: "POST",
    body: JSON.stringify({ mint, fallback_payload: fallbackPayload }),
  });
}

/** Admin monitoring only — every executor the orchestrator currently knows
 * about, across all users. */
export async function listExecutors(): Promise<(BotStatusDto & { userId: string })[]> {
  const views = await request<RawExecutorView[]>("/internal/executors");
  return views.map((view) => ({ userId: view.user_id, ...toBotStatusDto(view) }));
}
