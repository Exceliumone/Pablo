"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Navbar } from "@/components/marketing/navbar";
import { Footer } from "@/components/marketing/footer";
import { Button } from "@/components/ui/button";
import { ConnectButton } from "@/components/wallet/connect-button";
import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { useAuth } from "@/components/providers/auth-provider";
import { useSubscription } from "@/lib/use-subscription";

/**
 * Auth + subscription gating lives here, once, instead of in every tab —
 * the six pages under app/app/* (sniper, portfolio, history, analytics,
 * wallet, settings) can assume an authenticated, Premium-subscribed user.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
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

  return <SubscriptionGate accessToken={accessToken}>{children}</SubscriptionGate>;
}

function SubscriptionGate({
  accessToken,
  children,
}: {
  accessToken: string;
  children: React.ReactNode;
}) {
  const { subscription, loading } = useSubscription(accessToken);

  if (loading && !subscription) {
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

  return <DashboardShell>{children}</DashboardShell>;
}
