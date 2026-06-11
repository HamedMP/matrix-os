import Link from "next/link";
import { ArrowRightIcon, BotIcon, BriefcaseBusinessIcon, GraduationCapIcon, ShieldCheckIcon } from "lucide-react";
import { palette as c, cardShadowSmall, fonts } from "./theme";
import { SectionShell, SectionTitle } from "./primitives";
import { Reveal } from "./Reveal";

const beyondCards = [
  {
    Icon: BriefcaseBusinessIcon,
    label: "Professionals",
    title: "A cloud assistant with its own computer",
    desc: "Use Matrix as a personal operator for planning, research, follow-ups, docs, dashboards, and recurring work.",
    href: "/solutions/professional-ai-assistant-cloud-computer",
  },
  {
    Icon: BotIcon,
    label: "Hermes hosting",
    title: "Host a Matrix-native agent without DevOps",
    desc: "Give Hermes an always-on home for connected tools, scheduled workflows, approvals, and notifications.",
    href: "/solutions/hermes-ai-agent-hosting",
  },
  {
    Icon: ShieldCheckIcon,
    label: "Enterprise",
    title: "AI experiments away from managed laptops",
    desc: "Give builders isolated Matrix computers for trials, prototypes, and agent workflows when IT policy blocks local installs.",
    href: "/solutions/enterprise-ai-coding-lab",
  },
  {
    Icon: GraduationCapIcon,
    label: "Universities",
    title: "Repeatable labs for AI-native development",
    desc: "Provision the same cloud dev environment for students, cohorts, workshops, and research groups.",
    href: "/solutions/university-ai-development-lab",
  },
] as const;

export function BeyondDevelopersSection() {
  return (
    <SectionShell className="pt-16 md:pt-28">
      <Reveal>
        <div className="mb-8 max-w-[44rem] md:mb-10">
          <SectionTitle
            title="Beyond developers."
            continuation="The same computer supports teams, pilots, and programs."
          />
        </div>
      </Reveal>
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {beyondCards.map((card, index) => (
          <Reveal key={card.title} delay={(index % 4) * 80}>
            <Link
              href={card.href}
              className="group flex h-full min-h-[15rem] flex-col rounded-2xl p-7 transition-transform duration-300 hover:-translate-y-1"
              style={{ backgroundColor: c.card, boxShadow: cardShadowSmall }}
            >
              <span
                className="mb-5 grid size-10 place-items-center rounded-lg"
                style={{ backgroundColor: "rgba(67,78,63,0.07)", color: c.forest }}
              >
                <card.Icon className="size-4" />
              </span>
              <p className="mb-2 text-[0.8125rem] font-medium" style={{ color: c.subtle, fontFamily: fonts.sans }}>
                {card.label}
              </p>
              <h3 className="mb-3 text-[1.0625rem] font-medium leading-[1.3]" style={{ color: c.deep, fontFamily: fonts.sans }}>
                {card.title}
              </h3>
              <p className="text-[0.9375rem] leading-[1.6]" style={{ color: c.mutedFg }}>{card.desc}</p>
              <span className="mt-auto inline-flex items-center gap-1.5 pt-6 text-[0.9375rem] font-medium" style={{ color: c.forest }}>
                Explore
                <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          </Reveal>
        ))}
      </div>
    </SectionShell>
  );
}
