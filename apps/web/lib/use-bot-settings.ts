"use client";

import { useCallback, useEffect, useState } from "react";
import type { BotSettingsDto } from "@pablo/shared-types";
import { apiFetch, ApiError } from "./api";

interface UseBotSettingsResult {
  settings: BotSettingsDto | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updateSettings: (patch: Partial<BotSettingsDto>) => Promise<void>;
  saving: boolean;
}

/** Settings CRUD only. The server already restarts a running executor with
 * fresh settings on save (bot.service.ts) — the client never needs to know
 * run status to use this, which is what keeps it independent of use-bot.ts. */
export function useBotSettings(accessToken: string | null): UseBotSettingsResult {
  const [settings, setSettings] = useState<BotSettingsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      setSettings(await apiFetch<BotSettingsDto>("/bot/settings", { accessToken }));
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
      setSaving(true);
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
        setSaving(false);
      }
    },
    [accessToken],
  );

  return { settings, loading, error, refresh, updateSettings, saving };
}
