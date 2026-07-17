"use client";

import { useCallback, useEffect, useState } from "react";
import type { PlatformStatsDto } from "@pablo/shared-types";
import { apiFetch, ApiError } from "./api";

export function useAdminStats(accessToken: string | null) {
  const [stats, setStats] = useState<PlatformStatsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      setStats(await apiFetch<PlatformStatsDto>("/admin/stats", { accessToken }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { stats, loading, error, refresh };
}
