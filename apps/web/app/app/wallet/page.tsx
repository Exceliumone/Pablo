"use client";

import { Loader2, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DepositPanel } from "@/components/wallet/deposit-panel";
import { WithdrawForm } from "@/components/wallet/withdraw-form";
import { useAuth } from "@/components/providers/auth-provider";
import { useWallet } from "@/lib/use-wallet";

export default function WalletPage() {
  const { accessToken } = useAuth();
  const { wallet, loading, error, withdraw, withdrawing } = useWallet(accessToken);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-pablo-400">
          Wallet
        </p>
        <h1 className="mt-3 text-balance font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
          Votre wallet de trading
        </h1>
      </div>

      {loading && !wallet && (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-pablo-400" />
        </div>
      )}

      {error && (
        <div className="glass flex flex-col items-center gap-3 rounded-xl p-7 text-center">
          <p className="text-sm text-danger">{error}</p>
          <Button variant="glass" size="sm" onClick={() => window.location.reload()}>
            <RefreshCcw className="h-3.5 w-3.5" />
            Réessayer
          </Button>
        </div>
      )}

      {wallet && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div className="glass rounded-xl p-5">
              <p className="text-xs text-muted-foreground">Solde SOL</p>
              <p className="text-tabular mt-1.5 font-display text-2xl font-bold text-foreground">
                {wallet.solBalance !== null ? `${wallet.solBalance.toFixed(4)} SOL` : "—"}
              </p>
              {wallet.solBalance === null && (
                <p className="mt-1 text-[11px] text-muted-foreground/70">
                  RPC indisponible dans cet environnement
                </p>
              )}
            </div>
            <div className="glass rounded-xl p-5">
              <p className="text-xs text-muted-foreground">Solde $PABLO</p>
              <p className="text-tabular mt-1.5 font-display text-2xl font-bold text-foreground">
                {wallet.pabloBalance ?? "—"}
              </p>
              {wallet.pabloBalance === null && (
                <p className="mt-1 text-[11px] text-muted-foreground/70">
                  RPC indisponible dans cet environnement
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <DepositPanel wallet={wallet} />
            <WithdrawForm maxSol={wallet.solBalance} withdrawing={withdrawing} onWithdraw={withdraw} />
          </div>
        </>
      )}
    </div>
  );
}
