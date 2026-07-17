"use client";

import { motion } from "framer-motion";

const STATS = [
  { value: "4+", label: "Protocoles DEX", detail: "PumpFun, PumpSwap, Raydium, Meteora" },
  { value: "1", label: "Abonnement", detail: "10 $/mois, en SOL uniquement" },
  { value: "gRPC", label: "Détection", detail: "Flux direct Yellowstone, pas de polling" },
  { value: "0", label: "Fichier .env à toucher", detail: "Tous les réglages depuis le dashboard" },
];

export function Stats() {
  return (
    <section className="border-y border-surface-border/10 bg-surface/30 py-16">
      <div className="container grid grid-cols-2 gap-8 md:grid-cols-4">
        {STATS.map((stat, i) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ delay: i * 0.07, duration: 0.4 }}
            className="text-center"
          >
            <p className="font-display text-4xl font-black text-pablo-300 md:text-5xl">
              <span className="text-tabular">{stat.value}</span>
            </p>
            <p className="mt-2 text-sm font-semibold text-foreground">{stat.label}</p>
            <p className="mt-1 text-xs text-muted-foreground">{stat.detail}</p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
