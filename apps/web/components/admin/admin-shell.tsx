"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import {
  ArrowLeftRight,
  FileClock,
  Gauge,
  LogOut,
  ScrollText,
  Users,
  Wallet2,
} from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/admin", label: "Statistiques", icon: Gauge, exact: true },
  { href: "/admin/users", label: "Utilisateurs", icon: Users, exact: false },
  { href: "/admin/subscriptions", label: "Abonnements", icon: ArrowLeftRight, exact: false },
  { href: "/admin/holders", label: "Holders", icon: Wallet2, exact: false },
  { href: "/admin/executors", label: "Executors", icon: FileClock, exact: false },
  { href: "/admin/logs", label: "Logs", icon: ScrollText, exact: false },
] as const;

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { signOut } = useAuth();

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
            <span className="rounded-full bg-pablo-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-pablo-300">
              Admin
            </span>
          </Link>

          <div className="flex items-center gap-4">
            <Link
              href="/app"
              className="hidden text-xs text-muted-foreground transition-colors hover:text-foreground sm:inline"
            >
              Retour au dashboard
            </Link>
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

        <nav className="scroll-fade-x container flex gap-1 overflow-x-auto pb-3 pr-6">
          {TABS.map((tab) => {
            const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);
            const Icon = tab.icon;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  "relative flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  active
                    ? "text-pablo-300"
                    : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
                )}
              >
                {active && (
                  <motion.span
                    layoutId="admin-tab-active"
                    className="absolute inset-0 rounded-md bg-pablo-500/15"
                    transition={{ type: "spring", stiffness: 500, damping: 35 }}
                  />
                )}
                <Icon className="relative h-3.5 w-3.5" />
                <span className="relative">{tab.label}</span>
              </Link>
            );
          })}
        </nav>
      </header>

      <main className="container flex-1 py-10">{children}</main>
    </div>
  );
}
