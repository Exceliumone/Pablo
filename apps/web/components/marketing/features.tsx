"use client";

import { motion } from "framer-motion";
import {
  BarChart3,
  Bell,
  Layers,
  Radar,
  ShieldCheck,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";

const FEATURES = [
  {
    icon: Radar,
    title: "Sniper temps réel",
    body: "Nouvelles paires, liquidité, market cap, holders, taxes et score de risque dès la création du pool.",
  },
  {
    icon: Users,
    title: "Copy trading",
    body: "Suivez un ou plusieurs wallets cibles, avec exclusions et limites configurables.",
  },
  {
    icon: TrendingUp,
    title: "TP / SL / Trailing Stop",
    body: "Moteur de vente avec trailing stop dynamique par palier de PnL — pas de sortie manuelle à gérer.",
  },
  {
    icon: Layers,
    title: "Multi-DEX",
    body: "PumpFun, PumpSwap, Raydium (AMM, CLMM, CPMM, Launchpad) et Meteora, dans un seul flux.",
  },
  {
    icon: BarChart3,
    title: "Portfolio & Analytics",
    body: "PnL en direct, ROI, win rate, capital, historique complet — sans quitter le dashboard.",
  },
  {
    icon: Bell,
    title: "Notifications live",
    body: "Opportunité détectée, trade exécuté, TP/SL atteint, erreur, bot arrêté — poussées en temps réel.",
  },
  {
    icon: Wallet,
    title: "Wallet à votre façon",
    body: "Wallet de trading généré automatiquement, ou importez le vôtre. Dépôt et retrait en un clic.",
  },
  {
    icon: ShieldCheck,
    title: "Sécurité de niveau institutionnel",
    body: "Clés privées chiffrées (KMS), exécution isolée par abonné, jamais de clé en clair.",
  },
];

export function Features() {
  return (
    <section id="features" className="border-y border-surface-border/10 bg-surface/30 py-24">
      <div className="container">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-pablo-400">
            Fonctionnalités
          </p>
          <h2 className="mt-3 text-balance font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
            Tout ce qu'un terminal pro devrait avoir
          </h2>
        </div>

        <div className="mt-16 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map((feature, i) => (
            <motion.div
              key={feature.title}
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ delay: (i % 4) * 0.06, duration: 0.4 }}
              className="glass group rounded-xl p-6 transition-colors hover:border-pablo-500/30"
            >
              <div className="inline-flex rounded-lg bg-pablo-500/10 p-2.5 text-pablo-300 transition-colors group-hover:bg-pablo-500/20">
                <feature.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-4 font-display text-lg font-bold text-foreground">
                {feature.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                {feature.body}
              </p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
