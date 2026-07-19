"use client";

import { useState } from "react";
import { AlertTriangle, Check, Copy, Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import type { WalletExportDto } from "@pablo/shared-types";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";

/** Mirrors withdraw-form.tsx's click-then-confirm pattern, but for a
 * strictly-more-dangerous action: a withdrawal is a bounded, one-time,
 * on-chain transfer; this hands over the raw key, i.e. permanent,
 * unbounded, unrevocable control of the wallet. The revealed key is kept
 * only in this component's own state — cleared by `hide()`, and never
 * written to `use-wallet.ts`'s state or anywhere else that could
 * re-render it back into view later or survive a refresh. */
export function ExportKeyPanel({
  onExport,
  exporting,
}: {
  onExport: () => Promise<WalletExportDto>;
  exporting: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [revealed, setRevealed] = useState<WalletExportDto | null>(null);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copied, copy } = useCopyToClipboard();

  function hide() {
    setRevealed(null);
    setVisible(false);
    setConfirming(false);
  }

  async function reveal() {
    setError(null);
    try {
      const result = await onExport();
      setRevealed(result);
      setVisible(true);
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "L'export a échoué.");
      setConfirming(false);
    }
  }

  return (
    <div className="glass flex min-w-0 flex-col rounded-xl p-7">
      <div className="inline-flex w-fit items-center gap-2 rounded-lg bg-danger/10 p-2.5 text-danger">
        <KeyRound className="h-5 w-5" />
      </div>
      <h3 className="mt-4 font-display text-lg font-bold text-foreground">
        Clé privée du wallet
      </h3>
      <p className="mt-2 text-sm text-muted-foreground">
        À utiliser uniquement en cas de besoin (perte d&apos;accès, envie de reprendre le
        contrôle direct). Quiconque obtient cette clé a un contrôle total et définitif sur ce
        wallet — ne la partagez jamais, ne la collez nulle part d&apos;autre.
      </p>

      <div className="mt-6 space-y-4">
        {!revealed ? (
          !confirming ? (
            <Button
              className="w-full"
              variant="glass"
              onClick={() => setConfirming(true)}
            >
              <Eye className="h-3.5 w-3.5" />
              Afficher la clé privée
            </Button>
          ) : (
            <div className="flex flex-col gap-3 rounded-md border border-danger/30 bg-danger/5 p-4">
              <div className="flex items-start gap-2 text-sm text-foreground">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                <p>
                  Cette clé donne un accès complet et irréversible à ce wallet. Confirmez-vous
                  vouloir l&apos;afficher ?
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void reveal()} disabled={exporting}>
                  {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Confirmer
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirming(false)}
                  disabled={exporting}
                >
                  Annuler
                </Button>
              </div>
            </div>
          )
        ) : (
          <div className="flex flex-col gap-3 rounded-md border border-danger/30 bg-danger/5 p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Clé privée (base58)
              </span>
              <Button size="sm" variant="ghost" onClick={hide}>
                <EyeOff className="h-3.5 w-3.5" />
                Masquer
              </Button>
            </div>
            <div className="text-tabular break-all rounded-md bg-black/30 p-3 text-xs text-foreground">
              {visible ? revealed.secretKeyB58 : "•".repeat(64)}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setVisible((v) => !v)}>
                {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                {visible ? "Cacher" : "Révéler"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void copy(revealed.secretKeyB58)}>
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-success" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copied ? "Copié" : "Copier"}
              </Button>
            </div>
          </div>
        )}

        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </div>
  );
}
