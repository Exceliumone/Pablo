"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdminUserDetailDto, AdminUserListItemDto, AdminUserPatchDto } from "@pablo/shared-types";
import { apiFetch, ApiError } from "./api";

const PAGE_SIZE = 25;

export function useAdminUsers(accessToken: string | null) {
  const [users, setUsers] = useState<AdminUserListItemDto[]>([]);
  const [totalCount, setTotalCount] = useState(0);
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
        const page = await apiFetch<{
          users: AdminUserListItemDto[];
          nextCursor: string | null;
          totalCount: number;
        }>(`/admin/users?${params.toString()}`, { accessToken });
        setUsers((prev) => (replace ? page.users : [...prev, ...page.users]));
        setCursor(page.nextCursor);
        setTotalCount(page.totalCount);
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

  const refresh = useCallback(async () => fetchPage(null, true), [fetchPage]);

  const updateUser = useCallback(
    async (userId: string, patch: AdminUserPatchDto) => {
      if (!accessToken) return;
      await apiFetch<AdminUserDetailDto>(`/admin/users/${userId}`, {
        method: "PATCH",
        accessToken,
        body: JSON.stringify(patch),
      });
      await refresh();
    },
    [accessToken, refresh],
  );

  return { users, totalCount, loading, loadingMore, error, hasMore: cursor !== null, loadMore, updateUser };
}
