"use client";

import { Loader2, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BotSettingsForm } from "@/components/bot/bot-settings-form";
import { useAuth } from "@/components/providers/auth-provider";
import { useBotSettings } from "@/lib/use-bot-settings";

export default function SettingsPage() {
  const { accessToken } = useAuth();
  const { settings, loading, error, updateSettings, saving } = useBotSettings(accessToken);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-pablo-400">
          Réglages
        </p>
        <h1 className="mt-3 text-balance font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
          Paramètres du bot
        </h1>
        <p className="mt-3 text-sm text-muted-foreground">
          Montant, take-profit / stop-loss, slippage, priority fee, copy-trading — appliqués
          directement au moteur.
        </p>
      </div>

      {loading && !settings && (
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

      {settings && <BotSettingsForm settings={settings} onSave={updateSettings} saving={saving} />}
    </div>
  );
}
