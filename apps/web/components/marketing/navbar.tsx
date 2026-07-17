"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConnectButton } from "@/components/wallet/connect-button";

const LINKS = [
  { href: "#features", label: "Fonctionnalités" },
  { href: "#roadmap", label: "Roadmap" },
  { href: "#faq", label: "FAQ" },
];

export function Navbar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
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

        <nav className="hidden items-center gap-8 md:flex">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <ConnectButton />
          <Button asChild size="default">
            <Link href="/subscribe">Launch App</Link>
          </Button>
        </div>

        <button
          className="text-foreground md:hidden"
          onClick={() => setMobileOpen((v) => !v)}
          aria-label="Toggle menu"
        >
          {mobileOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </div>

      {mobileOpen && (
        <div className="glass mx-4 mb-4 flex flex-col gap-4 rounded-lg p-5 md:hidden">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              onClick={() => setMobileOpen(false)}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {link.label}
            </a>
          ))}
          <div className="flex flex-col gap-3 pt-2">
            <ConnectButton />
            <Button asChild size="default">
              <Link href="/subscribe">Launch App</Link>
            </Button>
          </div>
        </div>
      )}
    </header>
  );
}
