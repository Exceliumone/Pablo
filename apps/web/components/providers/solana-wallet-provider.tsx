"use client";

import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";

/**
 * Phantom/Solflare are listed explicitly as a fallback for older extension
 * versions — most wallets today (Phantom, Solflare, Backpack, OKX...) are
 * auto-detected via the Wallet Standard, so this list is intentionally not
 * exhaustive.
 */
export function SolanaWalletProvider({ children }: { children: React.ReactNode }) {
  const endpoint =
    process.env.NEXT_PUBLIC_RPC_HTTP ?? "https://api.mainnet-beta.solana.com";
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
