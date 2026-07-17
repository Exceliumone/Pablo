"use client";

import { useCallback, useEffect, useState } from "react";
import type { AnalyticsSummaryDto } from "@pablo/shared-types";
import { apiFetch, ApiError } from "./api";

interface UseAnalyticsResult {
  summary: AnalyticsSummaryDto | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useAnalytics(accessToken: string | null): UseAnalyticsResult {
  const [summary, setSummary] = useState<AnalyticsSummaryDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      setSummary(await apiFetch<AnalyticsSummaryDto>("/analytics/summary", { accessToken }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { summary, loading, error, refresh };
}
