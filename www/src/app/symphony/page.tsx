import type { Metadata } from "next";
import { SiteHeader } from "@/components/landing/SiteHeader";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { SymphonySection } from "@/components/landing/SymphonySection";
import { HowItWorksSection } from "@/components/landing/HowItWorksSection";
import { AgentSetupSection } from "@/components/landing/AgentSetupSection";
import { FinalCtaSection } from "@/components/landing/FinalCtaSection";
import { CtaButton, PageHero } from "@/components/landing/primitives";
import { CopyPromptButton } from "@/components/landing/CopyPromptButton";
import { COPYABLE_AGENT_SETUP_PROMPT } from "@/components/landing/content";
import { palette as c, fonts } from "@/components/landing/theme";

export const metadata: Metadata = {
  title: "Symphony - Orchestrate background coding agents | Matrix OS",
  description:
    "Symphony runs background coding agents in parallel on your Matrix cloud computer: task queues, persistent terminal sessions, previews, and human review before anything merges.",
};

export default function SymphonyPage() {
  return (
    <div style={{ backgroundColor: c.pageBg, color: c.deep, fontFamily: fonts.sans }}>
      <SiteHeader />
      <main>
        <PageHero
          eyebrow="Symphony"
          title={
            <>
              Background coding agents,
              <br />
              orchestrated
            </>
          }
          sub="Assign work, run agents in parallel on a computer that never sleeps, and merge only what survives your review."
        >
          <CtaButton href="https://app.matrix-os.com" phLocation="symphony_hero" phTarget="start_cloud_dev">
            Get started
          </CtaButton>
          <CopyPromptButton text={COPYABLE_AGENT_SETUP_PROMPT} />
        </PageHero>
        <SymphonySection />
        <HowItWorksSection />
        <AgentSetupSection />
        <FinalCtaSection />
      </main>
      <SiteFooter />
    </div>
  );
}
