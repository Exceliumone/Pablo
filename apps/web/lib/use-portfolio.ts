"use client";

import { useCallback, useEffect, useState } from "react";
import type { PortfolioDto } from "@pablo/shared-types";
import { apiFetch, ApiError } from "./api";

interface UsePortfolioResult {
  portfolio: PortfolioDto | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function usePortfolio(accessToken: string | null): UsePortfolioResult {
  const [portfolio, setPortfolio] = useState<PortfolioDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      setPortfolio(await apiFetch<PortfolioDto>("/portfolio", { accessToken }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { portfolio, loading, error, refresh };
}
