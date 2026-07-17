import { Navbar } from "@/components/marketing/navbar";
import { Hero } from "@/components/marketing/hero";
import { Presentation } from "@/components/marketing/presentation";
import { Features } from "@/components/marketing/features";
import { Conviction } from "@/components/marketing/conviction";
import { Stats } from "@/components/marketing/stats";
import { Roadmap } from "@/components/marketing/roadmap";
import { Faq } from "@/components/marketing/faq";
import { CtaLaunch } from "@/components/marketing/cta-launch";
import { Footer } from "@/components/marketing/footer";

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <Presentation />
        <Features />
        <Conviction />
        <Stats />
        <Roadmap />
        <Faq />
        <CtaLaunch />
      </main>
      <Footer />
    </>
  );
}
