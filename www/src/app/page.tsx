import type { Metadata } from "next";
import { BodyOverflow } from "@/components/landing/ScrollScreenshot";
import { LandingBilling } from "@/components/landing/LandingBilling";
import { LandingTelemetry } from "@/components/landing/LandingTelemetry";
import { SiteHeader } from "@/components/landing/SiteHeader";
import { Hero } from "@/components/landing/Hero";
import { AgentMarquee } from "@/components/landing/AgentMarquee";
import { PlatformGrid } from "@/components/landing/PlatformGrid";
import { SurfacesSection } from "@/components/landing/SurfacesSection";
import { TemplatesShowcase } from "@/components/landing/TemplatesShowcase";
import { SymphonySection } from "@/components/landing/SymphonySection";
import { QuoteStats } from "@/components/landing/QuoteStats";
import { HermesSection } from "@/components/landing/HermesSection";
import { DeploymentSection } from "@/components/landing/DeploymentSection";
import { BlogPreviewSection } from "@/components/landing/BlogPreviewSection";
import { PilotBand } from "@/components/landing/PilotBand";
import { FaqSection } from "@/components/landing/FaqSection";
import { FinalCtaSection } from "@/components/landing/FinalCtaSection";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { faqItems } from "@/components/landing/content";
import { palette as c, fonts } from "@/components/landing/theme";

const jsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Organization", name: "Matrix OS", url: "https://matrix-os.com", logo: "https://matrix-os.com/rabbit.svg",
      sameAs: ["https://github.com/HamedMP/matrix-os", "https://x.com/joinmatrixos", "https://discord.gg/cSBBQWtPwV"] },
    { "@type": "SoftwareApplication", name: "Matrix OS", url: "https://matrix-os.com", applicationCategory: "OperatingSystem",
      operatingSystem: "Web", description: "A computer in the cloud for coding agents and AI workflows.",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" } },
    { "@type": "FAQPage", mainEntity: faqItems.map((item) => ({
        "@type": "Question", name: item.q, acceptedAnswer: { "@type": "Answer", text: item.a } })) },
  ],
});

export const metadata: Metadata = {
  title: "Matrix OS - A cloud computer for background AI agents",
  description:
    "Give AI agents their own cloud computer. Run Claude, Codex, Cursor, and more in a persistent hosted workspace, even when your laptop sleeps.",
};

export default function LandingPage() {
  return (
    <div style={{ backgroundColor: c.pageBg, color: c.deep, fontFamily: fonts.sans }}>
      {/* react-doctor-disable-next-line react-doctor/no-danger -- jsonLd is JSON.stringify of a static module-scope object (trusted, no user input); standard JSON-LD injection */}
      <script
        id="landing-json-ld"
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLd }}
      />
      <LandingTelemetry />
      <BodyOverflow />

      <SiteHeader />
      <main>
        <Hero />
        <AgentMarquee />
        <PlatformGrid />
        <SurfacesSection />
        <TemplatesShowcase />
        <SymphonySection exploreHref="/symphony" />
        <QuoteStats />
        <HermesSection exploreHref="/hermes" />
        <DeploymentSection />
        <LandingBilling />
        <BlogPreviewSection />
        <PilotBand />
        <FaqSection />
        <FinalCtaSection />
      </main>
      <SiteFooter />
    </div>
  );
}
