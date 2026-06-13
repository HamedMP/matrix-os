import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { palette as c, fonts } from "./theme";
import { SectionCard, SectionShell, SectionTitle } from "./primitives";
import { Reveal } from "./Reveal";
import { IsoArt } from "./IsoArt";

const platformFeatures = [
  {
    title: "Background agents",
    desc: "Task in, reviewed change out. Agents keep coding on their own computer long after you close the laptop.",
    linkLabel: "Explore Symphony",
    href: "/symphony",
    seed: 1,
  },
  {
    title: "Every coding agent, one computer",
    desc: "Claude, Codex, Cursor, OpenCode, Pi, and Gemini CLI in persistent sessions with repos, tests, and previews.",
    linkLabel: "See supported agents",
    href: "/docs/guide/agents",
    seed: 2,
  },
  {
    title: "Hermes, the resident agent",
    desc: "A Matrix-native agent for connected tools, scheduled workflows, notifications, and approvals.",
    linkLabel: "Meet Hermes",
    href: "/hermes",
    seed: 3,
  },
  {
    title: "Private by design",
    desc: "Your own database, files, and runtime on an isolated computer. Owner-controlled and exportable.",
    linkLabel: "Read the whitepaper",
    href: "/whitepaper",
    seed: 4,
  },
] as const;

export function PlatformGrid() {
  return (
    <SectionShell id="cloud-dev" className="pt-16 md:pt-28">
      <Reveal>
        <SectionCard>
          <div className="px-7 pt-9 pb-8 md:px-12 md:pt-12 md:pb-10" style={{ borderBottom: `1px solid ${c.border}` }}>
            <SectionTitle
              title="The always-on computer for background agents."
              continuation="You set the direction. Agents keep working while your devices sleep."
            />
          </div>
          <div className="grid md:grid-cols-2">
            {platformFeatures.map((feature, index) => (
              <div
                key={feature.title}
                className={`flex items-start justify-between gap-6 px-7 py-9 md:px-12 md:py-12 ${
                  ["border-b md:border-r", "border-b", "border-b md:border-b-0 md:border-r", ""][index]
                }`}
                style={{ borderColor: c.border }}
              >
                <div className="max-w-[19rem]">
                  <h3 className="text-[1.0625rem] font-medium" style={{ color: c.deep, fontFamily: fonts.sans }}>
                    {feature.title}
                  </h3>
                  <p className="mt-3 text-[0.9375rem] leading-[1.6]" style={{ color: c.mutedFg }}>
                    {feature.desc}
                  </p>
                  <Link
                    href={feature.href}
                    className="group mt-5 inline-flex items-center gap-1.5 text-[0.9375rem] font-medium transition-opacity hover:opacity-70"
                    style={{ color: c.forest }}
                  >
                    {feature.linkLabel}
                    <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </div>
                <div className="hidden w-[160px] shrink-0 sm:block">
                  <IsoArt seed={feature.seed} />
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      </Reveal>
    </SectionShell>
  );
}
