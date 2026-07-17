"use client";

import { useCallback, useEffect, useState } from "react";
import type { BotSettingsDto, BotStatusDto } from "@pablo/shared-types";
import { apiFetch, ApiError } from "./api";

interface UseBotResult {
  settings: BotSettingsDto | null;
  status: BotStatusDto | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updateSettings: (patch: Partial<BotSettingsDto>) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  actionPending: boolean;
}

export function useBot(accessToken: string | null): UseBotResult {
  const [settings, setSettings] = useState<BotSettingsDto | null>(null);
  const [status, setStatus] = useState<BotStatusDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const [settingsResult, statusResult] = await Promise.all([
        apiFetch<BotSettingsDto>("/bot/settings", { accessToken }),
        apiFetch<BotStatusDto>("/bot/status", { accessToken }),
      ]);
      setSettings(settingsResult);
      setStatus(statusResult);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateSettings = useCallback(
    async (patch: Partial<BotSettingsDto>) => {
      if (!accessToken) return;
      setActionPending(true);
      setError(null);
      try {
        const updated = await apiFetch<BotSettingsDto>("/bot/settings", {
          method: "PUT",
          accessToken,
          body: JSON.stringify(patch),
        });
        setSettings(updated);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not save settings.");
      } finally {
        setActionPending(false);
      }
    },
    [accessToken],
  );

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

  return { settings, status, loading, error, refresh, updateSettings, start, stop, actionPending };
}
