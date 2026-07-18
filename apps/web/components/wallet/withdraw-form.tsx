"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, Send } from "lucide-react";
import type { WithdrawalQuoteDto } from "@pablo/shared-types";
import { Button } from "@/components/ui/button";

export function WithdrawForm({
  quote,
  withdrawing,
  onWithdraw,
}: {
  quote: WithdrawalQuoteDto | null;
  withdrawing: boolean;
  onWithdraw: (toAddress: string, amountSol: number) => Promise<string>;
}) {
  const [toAddress, setToAddress] = useState("");
  const [amountSol, setAmountSol] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const maxSol = quote?.maxWithdrawableSol ?? null;
  const amount = Number(amountSol);
  const validAmount = amount > 0 && (maxSol === null || amount <= maxSol);
  const validAddress = toAddress.trim().length >= 32;

  async function submit() {
    setFormError(null);
    setResult(null);
    try {
      const signature = await onWithdraw(toAddress.trim(), amount);
      setResult(signature);
      setToAddress("");
      setAmountSol("");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Le retrait a échoué.");
    } finally {
      setConfirming(false);
    }
  }

  return (
    <div className="glass flex min-w-0 flex-col rounded-xl p-7">
      <div className="inline-flex w-fit items-center gap-2 rounded-lg bg-pablo-500/10 p-2.5 text-pablo-300">
        <Send className="h-5 w-5" />
      </div>
      <h3 className="mt-4 font-display text-lg font-bold text-foreground">Retirer des fonds</h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Arrêtez le bot avant de retirer — un retrait pendant qu&apos;il tourne pourrait entrer en
        conflit avec un trade en cours.
      </p>

      <div className="mt-6 space-y-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Adresse de destination
          </span>
          <input
            type="text"
            className="text-tabular w-full rounded-md border border-surface-border/20 bg-white/[0.03] px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-pablo-500/50"
            placeholder="Adresse Solana"
            value={toAddress}
            onChange={(e) => setToAddress(e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Montant {maxSol !== null && <span className="normal-case text-muted-foreground/70">— max {maxSol.toFixed(4)} SOL</span>}
          </span>
          <div className="flex gap-2">
            <input
              type="number"
              step="0.001"
              min="0"
              className="text-tabular w-full rounded-md border border-surface-border/20 bg-white/[0.03] px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-pablo-500/50"
              placeholder="0.00"
              value={amountSol}
              onChange={(e) => setAmountSol(e.target.value)}
            />
            {maxSol !== null && maxSol > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setAmountSol(maxSol.toFixed(6))}
              >
                Max
              </Button>
            )}
          </div>
        </label>

        {quote && (
          <div className="space-y-1 rounded-md border border-surface-border/20 bg-white/[0.02] p-3 text-xs text-muted-foreground">
            <div className="flex justify-between">
              <span>Solde du wallet</span>
              <span className="text-tabular">{quote.balanceSol.toFixed(6)} SOL</span>
            </div>
            <div className="flex justify-between">
              <span>Réserve rent-exempt</span>
              <span className="text-tabular">− {quote.rentExemptReserveSol.toFixed(6)} SOL</span>
            </div>
            <div className="flex justify-between">
              <span>Frais de réseau estimés</span>
              <span className="text-tabular">− {quote.networkFeeSol.toFixed(6)} SOL</span>
            </div>
            <div className="flex justify-between border-t border-surface-border/20 pt-1 font-medium text-foreground">
              <span>Max retirable</span>
              <span className="text-tabular">{quote.maxWithdrawableSol.toFixed(6)} SOL</span>
            </div>
          </div>
        )}

        {!confirming ? (
          <Button
            className="w-full"
            variant="glass"
            disabled={!validAddress || !validAmount}
            onClick={() => setConfirming(true)}
          >
            Retirer
          </Button>
        ) : (
          <div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/5 p-4">
            <p className="text-sm text-foreground">
              Envoyer <span className="font-semibold">{amount.toFixed(4)} SOL</span> vers{" "}
              <span className="text-tabular break-all">{toAddress.trim()}</span> ?
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void submit()} disabled={withdrawing}>
                {withdrawing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Confirmer
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={withdrawing}>
                Annuler
              </Button>
            </div>
          </div>
        )}

        {formError && <p className="text-xs text-danger">{formError}</p>}

        {result && (
          <div className="flex items-start gap-2 rounded-md bg-success/10 p-3 text-xs text-success">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="text-tabular break-all">Envoyé — signature {result}</span>
          </div>
        )}
      </div>
    </div>
  );
}
