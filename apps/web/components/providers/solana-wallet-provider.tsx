"use client";

import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import type { Adapter } from "@solana/wallet-adapter-base";
import { WalletAdapterNetwork } from "@solana/wallet-adapter-base";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { TrustWalletAdapter } from "@solana/wallet-adapter-trust";
import { BitgetWalletAdapter } from "@solana/wallet-adapter-bitkeep";
import { WalletConnectWalletAdapter } from "@solana/wallet-adapter-walletconnect";

/**
 * Phantom/Solflare/Trust/Bitget are listed explicitly as a fallback for
 * older extension versions or wallets not yet on the Wallet Standard —
 * most wallets today are auto-detected regardless, so this list is
 * intentionally not exhaustive. Each still only *appears* in the connect
 * menu if the matching browser extension is actually installed (see
 * ConnectButton's readyState filter) — that's how every adapter here
 * works, not a bug specific to one of them.
 *
 * WalletConnect is different: it doesn't need a browser extension at all
 * (it pairs with any mobile wallet — Trust, Bitget, Phantom mobile, etc. —
 * via QR code), so it's the option that actually broadens "which wallets
 * can connect" beyond whatever's installed locally. It needs a free
 * project ID from https://cloud.reown.com — see .env.example. Without one
 * set, it's simply omitted rather than shipping broken.
 */
export function SolanaWalletProvider({ children }: { children: React.ReactNode }) {
  const endpoint =
    process.env.NEXT_PUBLIC_RPC_HTTP ?? "https://api.mainnet-beta.solana.com";

  const wallets = useMemo(() => {
    const list: Adapter[] = [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new TrustWalletAdapter(),
      new BitgetWalletAdapter(),
    ];

    const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
    if (walletConnectProjectId && typeof window !== "undefined") {
      // window.location.origin rather than a hardcoded domain: this metadata
      // is shown in the pairing prompt on the wallet's side and should
      // reflect wherever this is actually running (localhost in dev, the
      // real domain in production) rather than guess at one.
      const origin = window.location.origin;
      list.push(
        new WalletConnectWalletAdapter({
          network: WalletAdapterNetwork.Mainnet,
          options: {
            projectId: walletConnectProjectId,
            metadata: {
              name: "PABLO",
              description: "PABLO — sniper trading terminal for $PABLO",
              url: origin,
              icons: [`${origin}/icon.png`],
            },
          },
        }),
      );
    }

    return list;
  }, []);

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        {children}
      </WalletProvider>
    </ConnectionProvider>
  );
}
