"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import bs58 from "bs58";
import type {
  AuthNonceResponse,
  AuthVerifyResponse,
  UserDto,
} from "@pablo/shared-types";
import { apiFetch, ApiError } from "@/lib/api";

type AuthStatus = "idle" | "restoring" | "signing-in" | "authenticated" | "error";

interface AuthContextValue {
  status: AuthStatus;
  user: UserDto | null;
  accessToken: string | null;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { publicKey, signMessage, disconnect, connected } = useWallet();
  const [status, setStatus] = useState<AuthStatus>("restoring");
  const [user, setUser] = useState<UserDto | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // On load, try to restore a session from the httpOnly refresh cookie
  // without requiring the wallet to reconnect — this is what lets a
  // returning subscriber land straight on the dashboard.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { accessToken: token } = await apiFetch<{ accessToken: string }>(
          "/auth/refresh",
          { method: "POST" },
        );
        const me = await apiFetch<UserDto>("/auth/me", { accessToken: token });
        if (cancelled) return;
        setAccessToken(token);
        setUser(me);
        setStatus("authenticated");
      } catch {
        if (!cancelled) setStatus("idle");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async () => {
    if (!publicKey || !signMessage) {
      setError("Connect a wallet that supports message signing first.");
      setStatus("error");
      return;
    }
    setStatus("signing-in");
    setError(null);
    try {
      const address = publicKey.toBase58();
      const { message } = await apiFetch<AuthNonceResponse>(
        `/auth/nonce?address=${address}`,
      );
      const signatureBytes = await signMessage(new TextEncoder().encode(message));
      const signature = bs58.encode(signatureBytes);

      const result = await apiFetch<AuthVerifyResponse>("/auth/verify", {
        method: "POST",
        body: JSON.stringify({ address, signature, provider: "wallet-standard" }),
      });

      setAccessToken(result.accessToken);
      setUser(result.user);
      setStatus("authenticated");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed.");
      setStatus("error");
    }
  }, [publicKey, signMessage]);

  const signOut = useCallback(async () => {
    await apiFetch("/auth/logout", { method: "POST" }).catch(() => undefined);
    setAccessToken(null);
    setUser(null);
    setStatus("idle");
    await disconnect().catch(() => undefined);
  }, [disconnect]);

  // Once a wallet connects and there's no session yet, prompt the SIWS
  // signature immediately — connecting a wallet *is* the sign-in gesture
  // here, there's no separate "now click sign in" step for the user.
  useEffect(() => {
    if (connected && publicKey && status === "idle") {
      void signIn();
    }
  }, [connected, publicKey, status, signIn]);

  const value = useMemo(
    () => ({ status, user, accessToken, error, signIn, signOut }),
    [status, user, accessToken, error, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
