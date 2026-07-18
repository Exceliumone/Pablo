"use client";

import { useEffect, useState } from "react";
import type { BotSettingsDto } from "@pablo/shared-types";
import { Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TagInput } from "@/components/ui/tag-input";
import { cn } from "@/lib/utils";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
      {hint && <span className="text-xs text-muted-foreground/70">{hint}</span>}
    </label>
  );
}

const inputClass =
  "text-tabular w-full rounded-md border border-surface-border/20 bg-white/[0.03] px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-pablo-500/50";

export function BotSettingsForm({
  settings,
  onSave,
  saving,
}: {
  settings: BotSettingsDto;
  onSave: (patch: Partial<BotSettingsDto>) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState(settings);

  useEffect(() => setDraft(settings), [settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);

  return (
    <form
      className="glass flex flex-col gap-6 rounded-xl p-7"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="font-display text-lg font-bold text-foreground">Réglages du bot</h3>
        <Button type="submit" size="sm" disabled={!dirty || saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Enregistrer
        </Button>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Montant par achat" hint="SOL">
          <input
            type="number"
            step="0.001"
            min="0"
            className={inputClass}
            value={draft.amountPerBuySol}
            onChange={(e) => setDraft({ ...draft, amountPerBuySol: Number(e.target.value) })}
          />
        </Field>

        <Field label="Protocole">
          <select
            className={inputClass}
            value={draft.protocolPreference}
            onChange={(e) =>
              setDraft({
                ...draft,
                protocolPreference: e.target.value as BotSettingsDto["protocolPreference"],
              })
            }
          >
            <option value="auto">Auto</option>
            <option value="pumpfun">PumpFun</option>
            <option value="pumpswap">PumpSwap</option>
            <option value="raydium">Raydium</option>
          </select>
        </Field>

        <Field label="Take-Profit" hint="%">
          <input
            type="number"
            step="1"
            className={inputClass}
            value={draft.takeProfitPct}
            onChange={(e) => setDraft({ ...draft, takeProfitPct: Number(e.target.value) })}
          />
        </Field>

        <Field label="Stop-Loss" hint="%, négatif">
          <input
            type="number"
            step="1"
            className={inputClass}
            value={draft.stopLossPct}
            onChange={(e) => setDraft({ ...draft, stopLossPct: Number(e.target.value) })}
          />
        </Field>

        <Field label="Trailing Stop" hint="% d'activation, vide = désactivé">
          <input
            type="number"
            step="1"
            className={inputClass}
            value={draft.trailingStopPct ?? ""}
            onChange={(e) =>
              setDraft({
                ...draft,
                trailingStopPct: e.target.value === "" ? null : Number(e.target.value),
              })
            }
          />
        </Field>

        <Field label="Slippage" hint="basis points (100 = 1%)">
          <input
            type="number"
            step="10"
            min="0"
            max="10000"
            className={inputClass}
            value={draft.slippageBps}
            onChange={(e) => setDraft({ ...draft, slippageBps: Number(e.target.value) })}
          />
        </Field>

        <Field label="Priority fee" hint="lamports">
          <input
            type="number"
            step="1000"
            min="0"
            className={inputClass}
            value={draft.priorityFeeLamports}
            onChange={(e) => setDraft({ ...draft, priorityFeeLamports: Number(e.target.value) })}
          />
        </Field>

        <Field label="Wallets de copy trading" hint="Entrée pour ajouter une adresse">
          <TagInput
            values={draft.copyTradingTargets}
            onChange={(copyTradingTargets) => setDraft({ ...draft, copyTradingTargets })}
            placeholder="Coller une adresse et appuyer sur Entrée"
          />
        </Field>
      </div>

      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="h-4 w-4 accent-pablo-500"
            checked={draft.autoSell}
            onChange={(e) => setDraft({ ...draft, autoSell: e.target.checked })}
          />
          Auto-sell (TP/SL/trailing géré automatiquement)
        </label>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="h-4 w-4 accent-pablo-500"
            checked={draft.copyTradingEnabled}
            onChange={(e) => setDraft({ ...draft, copyTradingEnabled: e.target.checked })}
          />
          Copy trading activé
        </label>
      </div>

      {dirty && (
        <p className={cn("text-xs text-pablo-300")}>
          Modifications non enregistrées — si le bot tourne, l&apos;enregistrement le redémarre
          avec les nouveaux réglages.
        </p>
      )}
    </form>
  );
}
