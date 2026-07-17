"use client";

import { useCallback, useEffect, useState } from "react";
import type { AuditLogDto } from "@pablo/shared-types";
import { apiFetch, ApiError } from "./api";

const PAGE_SIZE = 25;

export function useAdminLogs(accessToken: string | null) {
  const [logs, setLogs] = useState<AuditLogDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        const page = await apiFetch<{ logs: AuditLogDto[]; nextCursor: string | null }>(
          `/admin/logs?${params.toString()}`,
          { accessToken },
        );
        setLogs((prev) => (replace ? page.logs : [...prev, ...page.logs]));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not reach the server.");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [accessToken],
  );

  useEffect(() => {
    void fetchPage(null, true);
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    await fetchPage(cursor, false);
  }, [cursor, fetchPage]);

  return { logs, loading, loadingMore, error, hasMore: cursor !== null, loadMore };
}
