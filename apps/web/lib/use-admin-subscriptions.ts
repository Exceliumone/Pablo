"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdminUserListItemDto, SubscriptionStatus } from "@pablo/shared-types";
import { apiFetch, ApiError } from "./api";

const PAGE_SIZE = 25;

export function useAdminSubscriptions(accessToken: string | null) {
  const [users, setUsers] = useState<AdminUserListItemDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SubscriptionStatus | "ALL">("ALL");
  const [actionPending, setActionPending] = useState(false);

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
        if (status !== "ALL") params.set("status", status);
        const page = await apiFetch<{ users: AdminUserListItemDto[]; nextCursor: string | null }>(
          `/admin/subscriptions?${params.toString()}`,
          { accessToken },
        );
        setUsers((prev) => (replace ? page.users : [...prev, ...page.users]));
        setCursor(page.nextCursor);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Could not reach the server.");
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [accessToken, status],
  );

  useEffect(() => {
    void fetchPage(null, true);
  }, [fetchPage]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    await fetchPage(cursor, false);
  }, [cursor, fetchPage]);

  const refresh = useCallback(async () => fetchPage(null, true), [fetchPage]);

  const grant = useCallback(
    async (userId: string, days: number) => {
      if (!accessToken) return;
      setActionPending(true);
      try {
        await apiFetch(`/admin/subscriptions/${userId}/grant`, {
          method: "POST",
          accessToken,
          body: JSON.stringify({ days }),
        });
        await refresh();
      } finally {
        setActionPending(false);
      }
    },
    [accessToken, refresh],
  );

  const revoke = useCallback(
    async (userId: string) => {
      if (!accessToken) return;
      setActionPending(true);
      try {
        await apiFetch(`/admin/subscriptions/${userId}/revoke`, { method: "POST", accessToken });
        await refresh();
      } finally {
        setActionPending(false);
      }
    },
    [accessToken, refresh],
  );

  return {
    users,
    loading,
    loadingMore,
    error,
    hasMore: cursor !== null,
    loadMore,
    status,
    setStatus,
    grant,
    revoke,
    actionPending,
  };
}
