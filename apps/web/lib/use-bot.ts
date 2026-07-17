"use client";

import { useCallback, useEffect, useState } from "react";
import type { BotStatusDto } from "@pablo/shared-types";
import { apiFetch, ApiError } from "./api";

interface UseBotStatusResult {
  status: BotStatusDto | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  actionPending: boolean;
}

/** Status + start/stop only — independent of settings, so an unreachable
 * engine-bridge orchestrator (status) never blanks out the settings form,
 * and vice versa. See use-bot-settings.ts for the other half. */
export function useBot(accessToken: string | null): UseBotStatusResult {
  const [status, setStatus] = useState<BotStatusDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      setStatus(await apiFetch<BotStatusDto>("/bot/status", { accessToken }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const start = useCallback(async () => {
    if (!accessToken) return;
    setActionPending(true);
    setError(null);
    try {
      await apiFetch("/bot/start", { method: "POST", accessToken });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start the bot.");
    } finally {
      setActionPending(false);
    }
  }, [accessToken, refresh]);

  const stop = useCallback(async () => {
    if (!accessToken) return;
    setActionPending(true);
    setError(null);
    try {
      await apiFetch("/bot/stop", { method: "POST", accessToken });
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not stop the bot.");
    } finally {
      setActionPending(false);
    }
  }, [accessToken, refresh]);

  return { status, loading, error, refresh, start, stop, actionPending };
}
