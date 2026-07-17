import Image from "next/image";

export function Conviction() {
  return (
    <section className="container py-24">
      <div className="glass grid overflow-hidden rounded-2xl lg:grid-cols-2">
        <div className="relative min-h-[320px]">
          <Image
            src="/brand/alley.webp"
            alt="PABLO dans une ruelle, veste à capuche, entouré de tags « PABLO doesn't forgive » et « We don't sell »"
            fill
            className="object-cover object-top"
            sizes="(min-width: 1024px) 50vw, 100vw"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-background via-background/10 to-transparent lg:bg-gradient-to-r" />
        </div>

        <div className="flex flex-col justify-center p-10 md:p-14">
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-pablo-400">
            Discipline &gt; émotion
          </p>
          <h2 className="mt-3 text-balance font-display text-3xl font-extrabold leading-tight tracking-tight text-foreground md:text-4xl">
            PABLO ne pardonne pas aux mains faibles.
            <br />
            Le bot non plus.
          </h2>
          <p className="mt-5 text-muted-foreground">
            Pas de vente de panique, pas de sortie trop tôt par peur, pas de
            position tenue trop longtemps par espoir. Une fois vos règles
            posées — Take-Profit, Stop-Loss, Trailing Stop — le moteur les
            exécute exactement, à chaque fois, sans hésitation.
          </p>
        </div>
      </div>
    </section>
  );
}
