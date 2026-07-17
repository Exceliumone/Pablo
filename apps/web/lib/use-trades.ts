"use client";

import { useCallback, useEffect, useState } from "react";
import type { TradeDto, TradeSide } from "@pablo/shared-types";
import { apiFetch, ApiError } from "./api";

interface UseTradesResult {
  trades: TradeDto[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  side: TradeSide | "ALL";
  setSide: (side: TradeSide | "ALL") => void;
  loadMore: () => Promise<void>;
}

const PAGE_SIZE = 25;

export function useTrades(accessToken: string | null): UseTradesResult {
  const [trades, setTrades] = useState<TradeDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useState<TradeSide | "ALL">("ALL");

  const fetchPage = useCallback(
    async (after: string | null, replace: boolean) => {
      if (!accessToken) return;
      if (replace) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setError(null);
      try {
        const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
        if (after) params.set("cursor", after);
        if (side !== "ALL") params.set("side", side);
        const page = await apiFetch<{ trades: TradeDto[]; nextCursor: string | null }>(
          `/trades?${params.toString()}`,
          { accessToken },
        );
        setTrades((prev) => (replace ? page.trades : [...prev, ...page.trades]));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not reach the server.");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [accessToken, side],
  );

  useEffect(() => {
    void fetchPage(null, true);
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    await fetchPage(cursor, false);
  }, [cursor, fetchPage]);

  return { trades, loading, loadingMore, error, hasMore: cursor !== null, side, setSide, loadMore };
}
