"use client";

import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";

const fadeUp = {
  hidden: { opacity: 0, y: 16 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.08, duration: 0.5, ease: "easeOut" },
  }),
};

export function Hero() {
  return (
    <section className="relative overflow-hidden pb-24 pt-20 md:pb-32 md:pt-28">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-grid-fade bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_70%_60%_at_50%_0%,black,transparent)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-[-120px] h-[560px] w-[560px] -translate-x-1/2 rounded-full bg-pablo-600/25 blur-[140px]"
      />

      <div className="container relative grid items-center gap-16 lg:grid-cols-[1.1fr_0.9fr]">
        <div>
          <motion.div
            custom={0}
            initial="hidden"
            animate="show"
            variants={fadeUp}
            className="glass mb-6 inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-medium uppercase tracking-[0.2em] text-pablo-300"
          >
            <Zap className="h-3.5 w-3.5" />
            Moteur Rust natif &middot; gRPC direct
          </motion.div>

          <motion.h1
            custom={1}
            initial="hidden"
            animate="show"
            variants={fadeUp}
            className="text-balance font-display text-6xl font-black leading-[0.95] tracking-tight text-foreground md:text-7xl"
          >
            SNIPE.
            <br />
            <span className="bg-gradient-to-r from-pablo-300 via-pablo-400 to-pablo-500 bg-clip-text text-transparent">
              TRADE.
            </span>
            <br />
            BUILD.
          </motion.h1>

          <motion.p
            custom={2}
            initial="hidden"
            animate="show"
            variants={fadeUp}
            className="mt-6 max-w-lg text-balance text-lg text-muted-foreground"
          >
            Le terminal de trading du memecoin $PABLO. Détection de nouvelles
            paires en direct sur PumpFun, PumpSwap, Raydium et Meteora, moteur
            de vente Take-Profit / Stop-Loss / Trailing Stop, piloté depuis un
            vrai logiciel — pas un bot Telegram.
          </motion.p>

          <motion.div
            custom={3}
            initial="hidden"
            animate="show"
            variants={fadeUp}
            className="mt-9 flex flex-wrap items-center gap-4"
          >
            <Button size="lg" asChild>
              <Link href="/app" className="group">
                Launch App
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </Link>
            </Button>
            <Button size="lg" variant="glass" asChild>
              <a href="#features">Voir les fonctionnalités</a>
            </Button>
          </motion.div>

          <motion.p
            custom={4}
            initial="hidden"
            animate="show"
            variants={fadeUp}
            className="mt-6 text-sm text-muted-foreground"
          >
            Premium gratuit pour les détenteurs de{" "}
            <span className="font-medium text-pablo-300">$PABLO</span> &middot;
            sinon 10&nbsp;$/mois, payable uniquement en SOL.
          </motion.p>
        </div>

        <motion.div
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.7, ease: "easeOut" }}
          className="relative mx-auto w-full max-w-md"
        >
          <div
            aria-hidden
            className="absolute inset-0 -z-10 rounded-full bg-pablo-500/20 blur-[100px]"
          />
          <div className="glass overflow-hidden rounded-2xl shadow-glow-lg">
            <Image
              src="/brand/moon.webp"
              alt="PABLO, l'astronaute de $PABLO, drapeau planté sur la lune"
              width={900}
              height={900}
              priority
              className="h-auto w-full"
            />
          </div>
        </motion.div>
      </div>
    </section>
  );
}
