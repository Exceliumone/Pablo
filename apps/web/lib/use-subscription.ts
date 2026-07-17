"use client";

import { useCallback, useEffect, useState } from "react";
import type { SubscriptionViewDto } from "@pablo/shared-types";
import { apiFetch, ApiError } from "./api";

interface UseSubscriptionResult {
  subscription: SubscriptionViewDto | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** GET /billing/subscription always does a live reconciliation server-side
 * (payment period + $PABLO balance) — there's no separate "refresh" call,
 * calling this again *is* the refresh. */
export function useSubscription(accessToken: string | null): UseSubscriptionResult {
  const [subscription, setSubscription] = useState<SubscriptionViewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch<SubscriptionViewDto>("/billing/subscription", { accessToken });
      setSubscription(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { subscription, loading, error, refresh };
}
