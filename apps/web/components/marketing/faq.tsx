import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const FAQS = [
  {
    q: "Comment fonctionne l'abonnement Premium ?",
    a: "Un seul palier, 10 $/mois, payable uniquement en SOL directement sur la blockchain — pas de Stripe, pas de carte bancaire. Les détenteurs de $PABLO au-dessus du seuil défini y accèdent automatiquement et gratuitement.",
  },
  {
    q: "Que se passe-t-il si mon solde de $PABLO devient insuffisant ?",
    a: "Vous passez en période de grâce, avec notification. Ensuite, deux options identiques en droits d'accès : racheter du $PABLO, ou payer les 10 $/mois en SOL.",
  },
  {
    q: "Le bot a-t-il accès à mes fonds personnels ?",
    a: "Non. Votre wallet Phantom/Solflare sert uniquement à vous connecter et à payer l'abonnement — il ne signe jamais de trade. L'exécution utilise un wallet de trading dédié, que vous pouvez soit laisser générer automatiquement, soit importer vous-même.",
  },
  {
    q: "Quels DEX sont supportés ?",
    a: "PumpFun, PumpSwap, Raydium (AMM, CLMM, CPMM, Launchpad) et Meteora (DBC, DAMM), avec détection Honeypot et score de risque avant chaque snipe.",
  },
  {
    q: "Puis-je régler le Take-Profit, le Stop-Loss et le slippage moi-même ?",
    a: "Oui — montant par achat, TP, SL, trailing stop, priority fee, slippage, auto-sell, copy trading, listes blanche et noire : tout est modifiable depuis le dashboard, appliqué en direct au moteur.",
  },
  {
    q: "Le moteur de trading est-il un simple bot Telegram ?",
    a: "Non. C'est un moteur Rust natif qui écoute la blockchain via un flux gRPC direct (Yellowstone), piloté par un vrai tableau de bord web — pas des commandes tapées dans un chat.",
  },
];

export function Faq() {
  return (
    <section id="faq" className="container py-24">
      <div className="mx-auto max-w-2xl text-center">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-pablo-400">FAQ</p>
        <h2 className="mt-3 text-balance font-display text-4xl font-extrabold tracking-tight text-foreground md:text-5xl">
          Questions fréquentes
        </h2>
      </div>

      <Accordion type="single" collapsible className="mx-auto mt-14 max-w-2xl space-y-3">
        {FAQS.map((item, i) => (
          <AccordionItem key={item.q} value={`item-${i}`}>
            <AccordionTrigger>{item.q}</AccordionTrigger>
            <AccordionContent>{item.a}</AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </section>
  );
}
