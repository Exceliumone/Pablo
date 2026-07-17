"use client";

import { useEffect, useRef, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useAuth } from "@/components/providers/auth-provider";

// Matches @solana/wallet-adapter-walletconnect's WalletConnectWalletName
// constant, kept as a literal rather than imported: that package (via
// @walletconnect/solana-adapter) has no "sideEffects": false, so pulling in
// even just the constant drags the whole WalletConnect/QR-modal dependency
// graph into every bundle that imports it — and ConnectButton renders in
// the navbar on every page, not just wherever wallet-connect logic lives.
const WALLET_CONNECT_NAME = "WalletConnect";

function truncate(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Custom-styled in place of @solana/wallet-adapter-react-ui's stock modal —
 * that ships its own generic chrome that doesn't carry the PABLO glass/
 * violet treatment, and a connect button is core enough to the brand's
 * first impression to be worth owning directly.
 */
export function ConnectButton() {
  const { wallets, wallet, select, connect, connected, connecting, publicKey } = useWallet();
  const { status, user, error, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (wallet && !connected && !connecting) {
      connect().catch(() => undefined);
    }
    // Only re-run when the selected adapter changes.
  }, [wallet]);

  useEffect(() => {
    function onClickOutside(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  // WalletConnect has no browser extension to detect — it pairs with a
  // mobile wallet over a QR code — so it never earns Installed/Loadable
  // the way an extension-based adapter does. Always show it when present;
  // every other adapter (Phantom, Solflare, Trust, Bitget, ...) keeps the
  // usual detection-gated behavior.
  const available = wallets.filter(
    (w) =>
      w.adapter.name === WALLET_CONNECT_NAME ||
      w.readyState === WalletReadyState.Installed ||
      w.readyState === WalletReadyState.Loadable,
  );

  if (status === "authenticated" && user) {
    const primary =
      user.wallets.find((w) => w.isPrimary)?.address ?? publicKey?.toBase58() ?? "";
    return (
      <div className="relative" ref={rootRef}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="glass flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-foreground transition hover:border-pablo-500/40"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          <span className="text-tabular">{truncate(primary)}</span>
        </button>
        {open && (
          <div className="glass absolute right-0 z-50 mt-2 w-48 rounded-md p-1 text-sm shadow-glow">
            <button
              onClick={() => {
                setOpen(false);
                void signOut();
              }}
              className="w-full rounded-sm px-3 py-2 text-left text-muted-foreground transition hover:bg-white/5 hover:text-foreground"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
    );
  }

  const label =
    status === "signing-in" ? "Signing…" : connecting ? "Connecting…" : "Connect Wallet";

  return (
    <div className="relative" ref={rootRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={status === "signing-in" || connecting}
        className="rounded-md bg-pablo-600 px-4 py-2 text-sm font-semibold text-white shadow-glow transition hover:bg-pablo-500 disabled:opacity-60"
      >
        {label}
      </button>
      {open && (
        <div className="glass absolute right-0 z-50 mt-2 w-60 rounded-md p-1 text-sm shadow-glow">
          {available.length === 0 && (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              No Solana wallet extension detected. Install Phantom, Solflare, Trust, or
              Bitget, or connect a mobile wallet via WalletConnect.
            </p>
          )}
          {available.map((w) => (
            <button
              key={w.adapter.name}
              onClick={() => {
                select(w.adapter.name);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-foreground transition hover:bg-white/5"
            >
              <img src={w.adapter.icon} alt="" className="h-4 w-4" />
              {w.adapter.name}
            </button>
          ))}
        </div>
      )}
      {error && status === "error" && (
        <p className="absolute right-0 top-full mt-2 w-60 text-xs text-danger">{error}</p>
      )}
    </div>
  );
}
