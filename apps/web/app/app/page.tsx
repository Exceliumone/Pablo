"use client";

import Link from "next/link";
import { Loader2, RefreshCcw } from "lucide-react";
import { Navbar } from "@/components/marketing/navbar";
import { Footer } from "@/components/marketing/footer";
import { Button } from "@/components/ui/button";
import { ConnectButton } from "@/components/wallet/connect-button";
import { BotControlPanel } from "@/components/bot/bot-control-panel";
import { BotSettingsForm } from "@/components/bot/bot-settings-form";
import { BotEventFeed } from "@/components/bot/bot-event-feed";
import { useAuth } from "@/components/providers/auth-provider";
import { useSubscription } from "@/lib/use-subscription";
import { useBot } from "@/lib/use-bot";
import { useBotEvents } from "@/lib/use-bot-events";

export default function AppPage() {
  const { status: authStatus, accessToken } = useAuth();

  if (authStatus === "restoring") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-pablo-400" />
      </main>
    );
  }

  if (authStatus !== "authenticated" || !accessToken) {
    return (
      <>
        <Navbar />
        <main className="container flex min-h-[70vh] flex-col items-center justify-center gap-6 text-center">
          <h1 className="font-display text-3xl font-extrabold text-foreground">
            Connectez votre wallet
          </h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            Votre wallet Solana est votre compte — connectez-vous pour accéder au terminal.
          </p>
          <ConnectButton />
        </main>
        <Footer />
      </>
    );
  }

  return <AppContent accessToken={accessToken} />;
}

function AppContent({ accessToken }: { accessToken: string }) {
  const { subscription, loading: subLoading } = useSubscription(accessToken);
  const { settings, status, loading, error, updateSettings, start, stop, actionPending } =
    useBot(accessToken);
  const { events, connected } = useBotEvents(accessToken);

  if (subLoading && !subscription) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-pablo-400" />
      </main>
    );
  }

  if (subscription && subscription.status !== "ACTIVE") {
    return (
      <>
        <Navbar />
        <main className="container flex min-h-[70vh] flex-col items-center justify-center gap-6 text-center">
          <h1 className="font-display text-3xl font-extrabold text-foreground">
            Premium requis
          </h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            Le terminal de trading est réservé aux abonnés Premium — payez en SOL ou détenez du
            $PABLO pour débloquer l&apos;accès.
          </p>
          <Button asChild size="lg">
            <Link href="/subscribe">Voir mon abonnement</Link>
          </Button>
        </main>
        <Footer />
      </>
    );
  }

  return (
    <>
      <Navbar />
      <main className="container py-16">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-pablo-400">
            Terminal
          </p>
          <h1 className="mt-3 text-balance font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
            Pilotez votre bot
          </h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Scanner partagé, exécution dédiée à votre wallet — démarrez, réglez, observez en
            direct.
          </p>
        </div>

        <div className="mx-auto mt-12 max-w-3xl space-y-6">
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

          {status && <BotControlPanel status={status} onStart={start} onStop={stop} pending={actionPending} wsConnected={connected} />}

          {settings && (
            <BotSettingsForm settings={settings} onSave={updateSettings} saving={actionPending} />
          )}

          <BotEventFeed events={events} />
        </div>
      </main>
      <Footer />
    </>
  );
}
