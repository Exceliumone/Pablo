"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { ConnectButton } from "@/components/wallet/connect-button";
import { Button } from "@/components/ui/button";

export function CtaLaunch() {
  const { status, user } = useAuth();

  return (
    <section id="launch" className="container py-24">
      <div className="glass relative overflow-hidden rounded-2xl px-8 py-16 text-center shadow-glow-lg md:px-16">
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 h-[420px] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-pablo-600/25 blur-[130px]"
        />
        <div className="relative">
          <h2 className="text-balance font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
            {status === "authenticated" && user
              ? "Le terminal vous attend."
              : "Connectez un wallet. Signez. C'est tout."}
          </h2>
          <p className="mx-auto mt-4 max-w-md text-muted-foreground">
            {status === "authenticated" && user
              ? "Réglez votre bot, démarrez-le, suivez son activité en direct."
              : "Pas de mot de passe, pas d'inscription. Votre wallet Solana est votre compte."}
          </p>
          <div className="mt-8 flex justify-center">
            {status === "authenticated" && user ? (
              <Button size="lg" asChild>
                <Link href="/app" className="group">
                  Ouvrir le terminal
                  <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </Button>
            ) : (
              <ConnectButton />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
