"use client";

import Link from "next/link";
import { Loader2, ShieldAlert } from "lucide-react";
import { Navbar } from "@/components/marketing/navbar";
import { Footer } from "@/components/marketing/footer";
import { Button } from "@/components/ui/button";
import { ConnectButton } from "@/components/wallet/connect-button";
import { AdminShell } from "@/components/admin/admin-shell";
import { useAuth } from "@/components/providers/auth-provider";

/** Role-gated, not subscription-gated — admin staff shouldn't need a
 * Premium subscription to use the console. Matches the backend exactly:
 * every /admin/* route (besides GET /admin/config) requires the ADMIN
 * role specifically — SUPPORT exists in the schema but has no granted
 * capabilities yet, so it isn't let in here either. */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { status, user } = useAuth();

  if (status === "restoring") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-pablo-400" />
      </main>
    );
  }

  if (status !== "authenticated" || !user) {
    return (
      <>
        <Navbar />
        <main className="container flex min-h-[70vh] flex-col items-center justify-center gap-6 text-center">
          <h1 className="font-display text-3xl font-extrabold text-foreground">
            Connectez votre wallet
          </h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            La console admin nécessite un compte avec les droits appropriés.
          </p>
          <ConnectButton />
        </main>
        <Footer />
      </>
    );
  }

  if (user.role !== "ADMIN") {
    return (
      <>
        <Navbar />
        <main className="container flex min-h-[70vh] flex-col items-center justify-center gap-6 text-center">
          <div className="inline-flex rounded-full bg-danger/10 p-3 text-danger">
            <ShieldAlert className="h-6 w-6" />
          </div>
          <h1 className="font-display text-3xl font-extrabold text-foreground">Accès refusé</h1>
          <p className="max-w-sm text-sm text-muted-foreground">
            Ce compte n&apos;a pas les droits nécessaires pour accéder à la console admin.
          </p>
          <Button asChild size="lg">
            <Link href="/app">Retour au dashboard</Link>
          </Button>
        </main>
        <Footer />
      </>
    );
  }

  return <AdminShell>{children}</AdminShell>;
}
