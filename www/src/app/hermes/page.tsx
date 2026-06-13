import type { Metadata } from "next";
import { SiteHeader } from "@/components/landing/SiteHeader";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { HermesSection } from "@/components/landing/HermesSection";
import { WorkflowsSection } from "@/components/landing/WorkflowsSection";
import { FinalCtaSection } from "@/components/landing/FinalCtaSection";
import { CtaButton, PageHero } from "@/components/landing/primitives";
import { palette as c, fonts } from "@/components/landing/theme";

export const metadata: Metadata = {
  title: "Hermes - The resident agent for your cloud computer | Matrix OS",
  description:
    "Hermes is the Matrix-native background agent for everything around the code: connected tools, scheduled workflows, notifications, approvals, and recurring professional work.",
};

export default function HermesPage() {
  return (
    <div style={{ backgroundColor: c.pageBg, color: c.deep, fontFamily: fonts.sans }}>
      <SiteHeader />
      <main>
        <PageHero
          eyebrow="Hermes"
          title={
            <>
              An agent that does the work,
              <br />
              not just the chat
            </>
          }
          sub="Hermes lives on your Matrix computer with real tools: GitHub, Linear, Slack, Gmail, Calendar, Drive, and your apps. It runs workflows in the background and asks before it acts."
        >
          <CtaButton href="https://app.matrix-os.com" phLocation="hermes_hero" phTarget="start_cloud_dev">
            Get started
          </CtaButton>
          <CtaButton href="/contact?audience=hermes-hosting" variant="outline">
            Talk to Matrix
          </CtaButton>
        </PageHero>
        <HermesSection />
        <WorkflowsSection />
        <FinalCtaSection />
      </main>
      <SiteFooter />
    </div>
  );
}
