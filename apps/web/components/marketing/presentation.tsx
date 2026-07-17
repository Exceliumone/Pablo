"use client";

import { motion } from "framer-motion";

const POINTS = [
  {
    title: "Un vrai moteur, pas un script",
    body: "PABLO pilote un moteur d'exécution écrit en Rust : détection par flux gRPC direct (Yellowstone), pas de polling, pas de scraping.",
  },
  {
    title: "Une seule interface, tout le contrôle",
    body: "Montant par achat, Take-Profit, Stop-Loss, Trailing Stop, slippage, priority fee, listes noire/blanche — tout se règle depuis le dashboard, rien dans un fichier de config.",
  },
  {
    title: "Un abonnement, deux façons d'y accéder",
    body: "10 $/mois payables uniquement en SOL, ou gratuit en détenant $PABLO. Les deux donnent exactement le même accès Premium.",
  },
];

export function Presentation() {
  return (
    <section className="container py-24">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.5 }}
        className="mx-auto max-w-2xl text-center"
      >
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-pablo-400">
          Ce que c'est
        </p>
        <h2 className="mt-3 text-balance font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
          Le trading discipliné, à la vitesse du chain
        </h2>
        <p className="mt-4 text-muted-foreground">
          Pas d'émotions, pas d'onglets à surveiller. Le moteur regarde la
          chaîne pour vous et exécute selon vos règles — mêmes règles, jour et
          nuit.
        </p>
      </motion.div>

      <div className="mt-16 grid gap-6 md:grid-cols-3">
        {POINTS.map((point, i) => (
          <motion.div
            key={point.title}
            initial={{ opacity: 0, y: 16 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-80px" }}
            transition={{ delay: i * 0.08, duration: 0.45 }}
            className="glass group rounded-xl p-7 transition-colors hover:border-pablo-500/30"
          >
            <h3 className="font-display text-xl font-bold text-foreground transition-colors group-hover:text-pablo-200">
              {point.title}
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{point.body}</p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
