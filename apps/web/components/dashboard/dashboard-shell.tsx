"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  History,
  LogOut,
  Radar,
  Settings,
  Wallet as WalletIcon,
  Wallet2,
} from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/app", label: "Sniper", icon: Radar, exact: true },
  { href: "/app/portfolio", label: "Portfolio", icon: Wallet2, exact: false },
  { href: "/app/history", label: "Historique", icon: History, exact: false },
  { href: "/app/analytics", label: "Analytics", icon: BarChart3, exact: false },
  { href: "/app/wallet", label: "Wallet", icon: WalletIcon, exact: false },
  { href: "/app/settings", label: "Réglages", icon: Settings, exact: false },
] as const;

function truncateAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { user, signOut } = useAuth();
  const primaryWallet = user?.wallets.find((w) => w.isPrimary) ?? user?.wallets[0];

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-40 border-b border-surface-border/10 bg-background/70 backdrop-blur-xl">
        <div className="container flex h-16 items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5">
            <Image
              src="/brand/emblem.webp"
              alt="PABLO"
              width={32}
              height={32}
              className="rounded-full"
              priority
            />
            <span className="font-display text-xl font-extrabold tracking-wide text-foreground">
              PABLO
            </span>
          </Link>

          <div className="flex items-center gap-4">
            {primaryWallet && (
              <span className="text-tabular hidden text-xs text-muted-foreground sm:inline">
                {truncateAddress(primaryWallet.address)}
              </span>
            )}
            <button
              onClick={() => void signOut()}
              className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Déconnexion"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Déconnexion</span>
            </button>
          </div>
        </div>

        <nav className="container flex gap-1 overflow-x-auto pb-3">
          {TABS.map((tab) => {
            const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);
            const Icon = tab.icon;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  "flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-pablo-500/15 text-pablo-300"
                    : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {tab.label}
              </Link>
            );
          })}
        </nav>
      </header>

      <main className="container flex-1 py-10">{children}</main>
    </div>
  );
}
