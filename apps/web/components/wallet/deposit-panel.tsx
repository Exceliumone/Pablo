"use client";

import { useEffect, useRef, useState } from "react";
import type { WalletDto } from "@pablo/shared-types";
import { Check, Copy, QrCode } from "lucide-react";
import { createQR } from "@solana/pay";

export function DepositPanel({ wallet }: { wallet: WalletDto }) {
  const [copied, setCopied] = useState(false);
  const qrRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!qrRef.current) return;
    qrRef.current.innerHTML = "";
    const qr = createQR(`solana:${wallet.publicKey}`, 160, "#ffffff", "#2b1058");
    qr.append(qrRef.current);
  }, [wallet.publicKey]);

  async function copy() {
    await navigator.clipboard.writeText(wallet.publicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="glass flex min-w-0 flex-col rounded-xl p-7">
      <div className="inline-flex w-fit items-center gap-2 rounded-lg bg-pablo-500/10 p-2.5 text-pablo-300">
        <QrCode className="h-5 w-5" />
      </div>
      <h3 className="mt-4 font-display text-lg font-bold text-foreground">
        Wallet de trading
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Envoyez du SOL à cette adresse pour financer les achats du bot — c&apos;est le wallet
        qu&apos;utilise l&apos;executor, distinct de celui avec lequel vous vous êtes connecté.
      </p>

      <div className="mt-6 flex flex-col items-center gap-4">
        <div className="rounded-lg bg-white p-3">
          <div ref={qrRef} />
        </div>
        <button
          onClick={() => void copy()}
          className="text-tabular flex w-full min-w-0 items-center justify-between gap-2 rounded-md border border-surface-border/20 bg-white/[0.03] px-3 py-2 text-xs text-foreground transition-colors hover:border-pablo-500/40"
        >
          <span className="min-w-0 truncate">{wallet.publicKey}</span>
          {copied ? (
            <Check className="h-3.5 w-3.5 shrink-0 text-success" />
          ) : (
            <Copy className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
        </button>
      </div>
    </div>
  );
}
