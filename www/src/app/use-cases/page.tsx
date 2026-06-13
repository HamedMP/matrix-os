import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRightIcon,
  BotIcon,
  BriefcaseBusinessIcon,
  CloudIcon,
  GraduationCapIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TerminalIcon,
} from "lucide-react";
import { SiteHeader } from "@/components/landing/SiteHeader";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { SolutionsSection } from "@/components/landing/SolutionsSection";
import { DeploymentSection } from "@/components/landing/DeploymentSection";
import { FinalCtaSection } from "@/components/landing/FinalCtaSection";
import { CtaButton, PageHero, SectionCard, SectionShell, SectionTitle } from "@/components/landing/primitives";
import { Reveal } from "@/components/landing/Reveal";
import { palette as c, cardShadowSmall, fonts } from "@/components/landing/theme";

export const metadata: Metadata = {
  title: "Matrix OS Use Cases - Background agents at work",
  description:
    "Explore Matrix OS use cases: background coding agents for developers, enterprise AI experimentation, university labs, professional AI assistants, Hermes hosting, and always-on cloud computers.",
  openGraph: {
    title: "Matrix OS Use Cases - Background agents at work",
    description:
      "Explore Matrix OS use cases: background coding agents for developers, enterprise AI experimentation, university labs, professional AI assistants, Hermes hosting, and always-on cloud computers.",
    url: "https://matrix-os.com/use-cases",
    siteName: "Matrix OS",
    type: "website",
  },
};

const primaryUseCases = [
  {
    id: "developers",
    Icon: TerminalIcon,
    label: "Developers",
    title: "Background coding agents with a real computer",
    desc: "Give Claude, Codex, Cursor, OpenCode, and Hermes a persistent computer with repos, terminals, previews, tests, and PR-ready diffs.",
    bullets: ["Always-on terminal sessions", "Cloud previews and test runs", "Matrix skill + CLI onboarding"],
    cta: "Read solution",
    href: "/solutions/ai-coding-agents-cloud-workspace",
  },
  {
    id: "enterprise",
    Icon: ShieldCheckIcon,
    label: "Enterprise",
    title: "AI tool experiments away from managed laptops",
    desc: "Let employees evaluate the latest coding agents in isolated hosted computers when security policy blocks local installs or browser handoffs.",
    bullets: ["Separate from corporate laptops", "Region and power selection", "Controlled pilot path"],
    cta: "Read solution",
    href: "/solutions/enterprise-ai-coding-lab",
  },
  {
    id: "universities",
    Icon: GraduationCapIcon,
    label: "Education",
    title: "Repeatable cloud labs for AI-native software work",
    desc: "Provision the same Matrix environment for courses, workshops, research groups, and hackathons so students focus on building instead of local setup.",
    bullets: ["Standard environments", "Fast onboarding", "Works from shared or personal devices"],
    cta: "Read solution",
    href: "/solutions/university-ai-development-lab",
  },
] as const;

const broaderUseCases = [
  {
    id: "professional-assistant",
    Icon: BriefcaseBusinessIcon,
    title: "Professional assistant",
    desc: "An always-on assistant for research, planning, meeting prep, follow-ups, reports, inbox triage, dashboards, and documents. Hermes works across connected tools while your context stays in one workspace.",
  },
  {
    id: "hermes-hosting",
    Icon: BotIcon,
    title: "Easy hosting for Hermes",
    desc: "Host the Matrix-native agent without standing up your own server. Hermes gets a persistent computer, scheduled workflows, connected tools, approvals, notifications, and memory.",
  },
  {
    id: "cloud-computer",
    Icon: CloudIcon,
    title: "Always-on cloud computer",
    desc: "A personal computer in the cloud that holds files, apps, agents, terminals, workflows, and memory. Your device becomes the viewer.",
  },
  {
    id: "chief-of-staff",
    Icon: BriefcaseBusinessIcon,
    title: "Chief of staff workspace",
    desc: "Centralize plans, notes, messages, dashboards, follow-ups, and connected tools so Hermes can help coordinate the operating rhythm.",
  },
  {
    id: "ai-companion",
    Icon: SparklesIcon,
    title: "AI companion with real tools",
    desc: "Move beyond chat into a workspace where the assistant can create apps, run workflows, remember context, and ask for approval before acting.",
  },
] as const;

export default function UseCasesPage() {
  return (
    <div style={{ backgroundColor: c.pageBg, color: c.deep, fontFamily: fonts.sans }}>
      <SiteHeader />
      <main>
        <PageHero
          eyebrow="Use cases"
          title={
            <>
              Where background agents
              <br />
              go to work
            </>
          }
          sub="One private cloud computer, many jobs: autonomous coding, enterprise pilots, university labs, and an assistant that uses real tools."
        >
          <CtaButton href="https://app.matrix-os.com" phLocation="use_cases_hero" phTarget="start_cloud_dev">
            Get started
          </CtaButton>
          <CtaButton href="/contact" variant="outline">
            Talk to Matrix
          </CtaButton>
        </PageHero>

        <SectionShell className="pt-16 md:pt-24">
          <Reveal>
            <SectionCard>
              <div className="px-7 pt-9 pb-8 md:px-12 md:pt-12 md:pb-10" style={{ borderBottom: `1px solid ${c.border}` }}>
                <SectionTitle title="Start here." continuation="The three places Matrix lands first." />
              </div>
              <div className="grid md:grid-cols-3">
                {primaryUseCases.map((useCase, index) => (
                  <div
                    key={useCase.id}
                    className={`flex flex-col px-7 py-9 md:px-10 md:py-12 ${index < 2 ? "border-b md:border-b-0 md:border-r" : ""}`}
                    style={{ borderColor: c.border }}
                  >
                    <span
                      className="mb-5 grid size-10 place-items-center rounded-lg"
                      style={{ backgroundColor: "rgba(67,78,63,0.07)", color: c.forest }}
                    >
                      <useCase.Icon className="size-4" aria-hidden="true" />
                    </span>
                    <p className="mb-2 text-[0.8125rem] font-medium" style={{ color: c.subtle }}>
                      {useCase.label}
                    </p>
                    <h2 className="mb-3 text-[1.0625rem] font-medium leading-[1.3]" style={{ color: c.deep }}>
                      {useCase.title}
                    </h2>
                    <p className="text-[0.9375rem] leading-[1.6]" style={{ color: c.mutedFg }}>
                      {useCase.desc}
                    </p>
                    <ul className="mt-4 space-y-2">
                      {useCase.bullets.map((bullet) => (
                        <li key={bullet} className="flex items-center gap-2.5 text-[0.875rem]" style={{ color: c.mutedFg }}>
                          <span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: c.ember }} />
                          {bullet}
                        </li>
                      ))}
                    </ul>
                    <Link
                      href={useCase.href}
                      className="group mt-auto inline-flex items-center gap-1.5 pt-7 text-[0.9375rem] font-medium transition-opacity hover:opacity-70"
                      style={{ color: c.forest }}
                    >
                      {useCase.cta}
                      <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </div>
                ))}
              </div>
            </SectionCard>
          </Reveal>
        </SectionShell>

        <SectionShell className="pt-16 md:pt-28">
          <Reveal>
            <div className="mb-8 max-w-[44rem] md:mb-10">
              <SectionTitle
                title="Beyond coding."
                continuation="The same computer carries assistants, workflows, and programs."
              />
            </div>
          </Reveal>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {broaderUseCases.map((useCase, index) => (
              <Reveal key={useCase.id} delay={(index % 3) * 90}>
                <article
                  className="flex h-full flex-col rounded-2xl p-7"
                  style={{ backgroundColor: c.card, boxShadow: cardShadowSmall }}
                >
                  <span
                    className="mb-5 grid size-10 place-items-center rounded-lg"
                    style={{ backgroundColor: "rgba(67,78,63,0.07)", color: c.forest }}
                  >
                    <useCase.Icon className="size-4" aria-hidden="true" />
                  </span>
                  <h2 className="mb-3 text-[1.0625rem] font-medium leading-[1.3]" style={{ color: c.deep }}>
                    {useCase.title}
                  </h2>
                  <p className="text-[0.9375rem] leading-[1.6]" style={{ color: c.mutedFg }}>
                    {useCase.desc}
                  </p>
                </article>
              </Reveal>
            ))}
          </div>
        </SectionShell>

        <SolutionsSection />
        <DeploymentSection />
        <FinalCtaSection />
      </main>
      <SiteFooter />
    </div>
  );
}
