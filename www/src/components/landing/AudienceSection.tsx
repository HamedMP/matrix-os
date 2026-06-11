import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { palette as c, fonts } from "./theme";
import { SectionCard, SectionShell, SectionTitle } from "./primitives";
import { Reveal } from "./Reveal";

const audienceCards = [
  {
    label: "Individual developers",
    title: "Give your coding agents a cloud computer today",
    desc: "Sign up, install the Matrix CLI, install the Matrix skill in your coding agent, and run Claude, Codex, Cursor, OpenCode, Pi, or Gemini CLI inside your Matrix computer.",
    action: "Developer quickstart",
    href: "/docs/users/quickstart",
  },
  {
    label: "Teams and enterprise",
    title: "Try the latest AI tools without risking corporate laptops",
    desc: "Give developers isolated cloud computers for AI coding experiments, autonomous agents, previews, and tool trials while keeping local machines and company environments separate.",
    action: "Contact Matrix",
    href: "/contact?audience=enterprise",
  },
  {
    label: "Universities",
    title: "Standard workspaces for AI-native software courses",
    desc: "Provision repeatable cloud computers for classes, labs, research groups, and hackathons so students can use modern coding agents without local setup drift.",
    action: "Plan a pilot",
    href: "/contact?audience=university",
  },
] as const;

export function AudienceSection() {
  return (
    <SectionShell id="teams" className="pt-16 md:pt-28">
      <Reveal>
        <SectionCard>
          <div className="px-7 pt-9 pb-8 md:px-12 md:pt-12 md:pb-10" style={{ borderBottom: `1px solid ${c.border}` }}>
            <SectionTitle
              title="Start with developers."
              continuation="Expand to teams, enterprises, and universities."
            />
          </div>
          <div className="grid md:grid-cols-3">
            {audienceCards.map((card, index) => (
              <div
                key={card.label}
                className={`flex flex-col px-7 py-9 md:px-10 md:py-12 ${index < 2 ? "border-b md:border-b-0 md:border-r" : ""}`}
                style={{ borderColor: c.border }}
              >
                <p className="mb-4 text-[0.8125rem] font-medium" style={{ color: c.subtle, fontFamily: fonts.sans }}>
                  {card.label}
                </p>
                <h3 className="mb-3 text-[1.0625rem] font-medium leading-[1.35]" style={{ color: c.deep, fontFamily: fonts.sans }}>
                  {card.title}
                </h3>
                <p className="text-[0.9375rem] leading-[1.6]" style={{ color: c.mutedFg }}>
                  {card.desc}
                </p>
                <Link
                  href={card.href}
                  className="group mt-auto inline-flex items-center gap-1.5 pt-7 text-[0.9375rem] font-medium transition-opacity hover:opacity-70"
                  style={{ color: c.forest }}
                >
                  {card.action}
                  <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </div>
            ))}
          </div>
        </SectionCard>
      </Reveal>
    </SectionShell>
  );
}
