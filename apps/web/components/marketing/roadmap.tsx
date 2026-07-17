"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

type Status = "done" | "active" | "upcoming";

const PHASES: { phase: string; title: string; body: string; status: Status }[] = [
  {
    phase: "Phase 0",
    title: "Fondations",
    body: "Monorepo, moteur Rust importé sans modification, briques d'infrastructure, CI.",
    status: "done",
  },
  {
    phase: "Phase 1",
    title: "Identité & accueil",
    body: "Connexion multi-wallet (Phantom, Solflare...), landing page, gestion de session.",
    status: "done",
  },
  {
    phase: "Phase 2",
    title: "Abonnement Premium",
    body: "Paiement en SOL vérifié on-chain, accès gratuit pour les détenteurs de $PABLO, configuration admin.",
    status: "done",
  },
  {
    phase: "Phase 3",
    title: "Pont vers le moteur",
    body: "Scanner partagé, executor dédié par abonné, réglages appliqués en direct au moteur.",
    status: "done",
  },
  {
    phase: "Phase 4",
    title: "Dashboard trading",
    body: "Sniper en direct, portfolio, historique, analytics, notifications temps réel.",
    status: "done",
  },
  {
    phase: "Phase 5",
    title: "Landing page premium",
    body: "Animations au scroll, micro-interactions, optimisation mobile — sur toute la plateforme.",
    status: "done",
  },
  {
    phase: "Phase 6",
    title: "Console admin",
    body: "Utilisateurs, holders, licences, statistiques, logs, monitoring des executors.",
    status: "done",
  },
  {
    phase: "Phase 7",
    title: "Mise en production",
    body: "Charge, audit de sécurité, tests de bout en bout avant l'ouverture aux premiers abonnés.",
    status: "upcoming",
  },
];

const STATUS_LABEL: Record<Status, string> = {
  done: "Terminé",
  active: "En cours",
  upcoming: "À venir",
};

export function Roadmap() {
  return (
    <section id="roadmap" className="container py-24">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ duration: 0.5 }}
        className="mx-auto max-w-2xl text-center"
      >
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-pablo-400">
          Roadmap
        </p>
        <h2 className="mt-3 text-balance font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
          Construit en public, phase par phase
        </h2>
        <p className="mt-4 text-muted-foreground">
          Chaque phase est entièrement fonctionnelle avant que la suivante ne
          démarre.
        </p>
      </motion.div>

      <ol className="relative mx-auto mt-16 max-w-2xl border-l border-surface-border/20 pl-8">
        {PHASES.map((p, i) => (
          <motion.li
            key={p.phase}
            initial={{ opacity: 0, x: -10 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ delay: (i % 5) * 0.06, duration: 0.4 }}
            className="group relative mb-10 last:mb-0"
          >
            <span
              className={cn(
                "absolute -left-[calc(2rem+5px)] top-1.5 h-2.5 w-2.5 rounded-full transition-transform duration-300 group-hover:scale-125",
                p.status === "done" && "bg-success",
                p.status === "active" && "animate-pulse-glow bg-pablo-400",
                p.status === "upcoming" && "bg-muted-foreground/40",
              )}
            />
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-tabular text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {p.phase}
              </span>
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                  p.status === "done" && "bg-success/10 text-success",
                  p.status === "active" && "bg-pablo-500/15 text-pablo-300",
                  p.status === "upcoming" && "bg-white/5 text-muted-foreground",
                )}
              >
                {STATUS_LABEL[p.status]}
              </span>
            </div>
            <h3 className="mt-2 font-display text-xl font-bold text-foreground transition-colors group-hover:text-pablo-200">
              {p.title}
            </h3>
            <p className="mt-1.5 text-sm text-muted-foreground">{p.body}</p>
          </motion.li>
        ))}
      </ol>
    </section>
  );
}
