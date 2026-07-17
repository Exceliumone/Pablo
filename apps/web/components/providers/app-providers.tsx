"use client";

import { SolanaWalletProvider } from "./solana-wallet-provider";
import { AuthProvider } from "./auth-provider";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <SolanaWalletProvider>
      <AuthProvider>{children}</AuthProvider>
    </SolanaWalletProvider>
  );
}
