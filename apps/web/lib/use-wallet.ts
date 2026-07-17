"use client";

import { useCallback, useEffect, useState } from "react";
import type { WalletDto } from "@pablo/shared-types";
import { apiFetch, ApiError } from "./api";

interface UseWalletResult {
  wallet: WalletDto | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  withdraw: (toAddress: string, amountSol: number) => Promise<string>;
  withdrawing: boolean;
  withdrawError: string | null;
}

export function useWallet(accessToken: string | null): UseWalletResult {
  const [wallet, setWallet] = useState<WalletDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawError, setWithdrawError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      setWallet(await apiFetch<WalletDto>("/wallet", { accessToken }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the server.");
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const withdraw = useCallback(
    async (toAddress: string, amountSol: number) => {
      if (!accessToken) throw new Error("Not authenticated.");
      setWithdrawing(true);
      setWithdrawError(null);
      try {
        const result = await apiFetch<{ txSignature: string }>("/wallet/withdraw", {
          method: "POST",
          accessToken,
          body: JSON.stringify({ toAddress, amountSol }),
        });
        await refresh();
        return result.txSignature;
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Withdrawal failed.";
        setWithdrawError(message);
        throw err;
      } finally {
        setWithdrawing(false);
      }
    },
    [accessToken, refresh],
  );

  return { wallet, loading, error, refresh, withdraw, withdrawing, withdrawError };
}
