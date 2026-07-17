"use client";

import { useEffect, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { createTransfer, createQR } from "@solana/pay";
import BigNumber from "bignumber.js";
import { Wallet, Loader2, CheckCircle2 } from "lucide-react";
import type { PaymentIntentDto, PaymentStatusDto } from "@pablo/shared-types";
import { apiFetch, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";

const POLL_INTERVAL_MS = 3000;

export function PaymentPanel({
  accessToken,
  onConfirmed,
}: {
  accessToken: string;
  onConfirmed: () => void;
}) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();

  const [intent, setIntent] = useState<PaymentIntentDto | null>(null);
  const [phase, setPhase] = useState<"idle" | "creating" | "sending" | "polling" | "confirmed">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const qrRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  useEffect(() => {
    if (!intent || !qrRef.current) return;
    qrRef.current.innerHTML = "";
    const qr = createQR(intent.solanaPayUrl, 200, "#ffffff", "#2b1058");
    qr.append(qrRef.current);
  }, [intent]);

  async function startIntent() {
    setError(null);
    setPhase("creating");
    try {
      const created = await apiFetch<PaymentIntentDto>("/billing/payment-intent", {
        method: "POST",
        accessToken,
      });
      setIntent(created);
      setPhase("idle");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Impossible de créer le paiement.");
      setPhase("idle");
    }
  }

  function pollStatus(paymentId: string) {
    setPhase("polling");
    pollRef.current = setInterval(async () => {
      try {
        const status = await apiFetch<PaymentStatusDto>(`/billing/payment-intent/${paymentId}`, {
          accessToken,
        });
        if (status.status === "CONFIRMED") {
          if (pollRef.current) clearInterval(pollRef.current);
          setPhase("confirmed");
          onConfirmed();
        } else if (status.status === "FAILED" || status.status === "EXPIRED") {
          if (pollRef.current) clearInterval(pollRef.current);
          setError("Le paiement a expiré ou a échoué — réessayez.");
          setIntent(null);
          setPhase("idle");
        }
      } catch {
        // A transient poll failure isn't fatal — keep polling until expiry.
      }
    }, POLL_INTERVAL_MS);
  }

  async function payWithWallet() {
    if (!intent || !publicKey) return;
    setError(null);
    setPhase("sending");
    try {
      const transaction = await createTransfer(
        connection,
        publicKey,
        {
          recipient: new PublicKey(intent.recipient),
          amount: new BigNumber(intent.amountSol),
          reference: new PublicKey(intent.reference),
        },
      );
      await sendTransaction(transaction, connection);
      pollStatus(intent.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "La transaction a été refusée.");
      setPhase("idle");
    }
  }

  if (phase === "confirmed") {
    return (
      <div className="glass flex flex-col items-center gap-3 rounded-xl p-7 text-center">
        <CheckCircle2 className="h-8 w-8 text-success" />
        <h3 className="font-display text-lg font-bold text-foreground">Paiement confirmé</h3>
        <p className="text-sm text-muted-foreground">Votre accès Premium est actif.</p>
      </div>
    );
  }

  return (
    <div className="glass flex flex-col rounded-xl p-7">
      <div className="inline-flex w-fit rounded-lg bg-pablo-500/10 p-2.5 text-pablo-300">
        <Wallet className="h-5 w-5" />
      </div>
      <h3 className="mt-4 font-display text-lg font-bold text-foreground">Payer en SOL</h3>
      <p className="mt-2 text-sm text-muted-foreground">
        Un seul abonnement, réglé directement sur la blockchain — pas de
        carte, pas d'intermédiaire.
      </p>

      {!intent && (
        <Button className="mt-6" onClick={startIntent} disabled={phase === "creating"}>
          {phase === "creating" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            "Générer le paiement"
          )}
        </Button>
      )}

      {intent && (
        <div className="mt-6 space-y-5">
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-muted-foreground">Montant</span>
            <span className="text-tabular font-semibold text-foreground">
              {intent.amountSol.toFixed(4)} SOL
            </span>
          </div>

          <div className="flex justify-center rounded-lg bg-white p-3">
            <div ref={qrRef} />
          </div>
          <p className="text-center text-xs text-muted-foreground">
            Scannez avec un wallet Solana Pay, ou payez directement avec le
            wallet connecté
          </p>

          <Button
            className="w-full"
            onClick={payWithWallet}
            disabled={!publicKey || phase === "sending" || phase === "polling"}
          >
            {phase === "sending" && <Loader2 className="h-4 w-4 animate-spin" />}
            {phase === "polling" && <Loader2 className="h-4 w-4 animate-spin" />}
            {phase === "sending"
              ? "Confirmez dans votre wallet…"
              : phase === "polling"
                ? "En attente de confirmation on-chain…"
                : "Payer avec le wallet connecté"}
          </Button>
        </div>
      )}

      {error && <p className="mt-4 text-xs text-danger">{error}</p>}
    </div>
  );
}
