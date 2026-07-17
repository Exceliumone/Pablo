"use client";

import { Loader2, RefreshCcw } from "lucide-react";
import { Navbar } from "@/components/marketing/navbar";
import { Footer } from "@/components/marketing/footer";
import { Button } from "@/components/ui/button";
import { ConnectButton } from "@/components/wallet/connect-button";
import { SubscriptionStatus } from "@/components/subscribe/subscription-status";
import { HolderPanel } from "@/components/subscribe/holder-panel";
import { PaymentPanel } from "@/components/subscribe/payment-panel";
import { useAuth } from "@/components/providers/auth-provider";
import { useSubscription } from "@/lib/use-subscription";

export default function SubscribePage() {
  const { status, accessToken } = useAuth();

  if (status === "restoring") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-pablo-400" />
      </main>
    );
  }

  if (status !== "authenticated" || !accessToken) {
    return (
      <>
        <Navbar />
        <main className="container flex min-h-[70vh] flex-col items-center justify-center gap-6 text-center">
          <h1 className="font-display text-3xl font-extrabold text-foreground">
            Connectez votre wallet
          </h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            Votre wallet Solana est votre compte — connectez-vous pour voir
            votre statut d'abonnement.
          </p>
          <ConnectButton />
        </main>
        <Footer />
      </>
    );
  }

  return <SubscribeContent accessToken={accessToken} />;
}

function SubscribeContent({ accessToken }: { accessToken: string }) {
  const { subscription, loading, error, refresh } = useSubscription(accessToken);

  return (
    <>
      <Navbar />
      <main className="container py-16">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-pablo-400">
            Abonnement
          </p>
          <h1 className="mt-3 text-balance font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
            Votre accès Premium
          </h1>
        </div>

        <div className="mx-auto mt-12 max-w-3xl space-y-6">
          {loading && !subscription && (
            <div className="flex justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-pablo-400" />
            </div>
          )}

          {error && (
            <div className="glass flex flex-col items-center gap-3 rounded-xl p-7 text-center">
              <p className="text-sm text-danger">{error}</p>
              <Button variant="glass" size="sm" onClick={() => void refresh()}>
                <RefreshCcw className="h-3.5 w-3.5" />
                Réessayer
              </Button>
            </div>
          )}

          {subscription && (
            <>
              <SubscriptionStatus subscription={subscription} />

              {subscription.status !== "ACTIVE" && (
                <div className="grid gap-6 md:grid-cols-2">
                  <PaymentPanel accessToken={accessToken} onConfirmed={() => void refresh()} />
                  <HolderPanel holder={subscription.holder} />
                </div>
              )}

              {subscription.status === "ACTIVE" && subscription.source === "PAYMENT" && (
                <HolderPanel holder={subscription.holder} />
              )}
            </>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}
