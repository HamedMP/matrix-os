import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { palette as c, fonts } from "./theme";
import { SectionCard, SectionShell, SectionTitle } from "./primitives";
import { Reveal } from "./Reveal";

const DOT_COLS = 10;
const DOT_ROWS = 8;
const DOT_GAP = 16;

function dotTone(col: number, row: number, seed: number): string {
  const hash = (col * 7 + row * 13 + seed * 31 + col * row * 3) % 19;
  if (hash < 5) return c.deep;
  if (hash === 5) return c.ember;
  return "rgba(67, 78, 63, 0.16)";
}

function DotMatrix({ seed }: { seed: number }) {
  const width = (DOT_COLS - 1) * DOT_GAP + 6;
  const height = (DOT_ROWS - 1) * DOT_GAP + 6;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full max-w-[170px]"
      aria-hidden="true"
    >
      {Array.from({ length: DOT_ROWS }, (_, row) =>
        Array.from({ length: DOT_COLS }, (_, col) => (
          <circle
            key={`${row}-${col}`}
            cx={col * DOT_GAP + 3}
            cy={row * DOT_GAP + 3}
            r={3}
            fill={dotTone(col, row, seed)}
          />
        )),
      )}
    </svg>
  );
}

const platformFeatures = [
  {
    title: "Your agent gets a computer",
    desc: "Not a dashboard. A private hosted machine with files, shells, apps, previews, workflows, and memory.",
    linkLabel: "See how it works",
    href: "/docs/users/quickstart",
    seed: 1,
  },
  {
    title: "Run every coding agent",
    desc: "Claude, Codex, Cursor, OpenCode, Pi, and Gemini CLI in persistent sessions that outlive your laptop.",
    linkLabel: "Explore agents",
    href: "/docs/guide/agents",
    seed: 2,
  },
  {
    title: "Hermes, the resident agent",
    desc: "A Matrix-native agent for connected tools, scheduled workflows, notifications, and approvals.",
    linkLabel: "Meet Hermes",
    href: "/#hermes",
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
              title="The always-on agent computer."
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
                <div className="hidden w-[150px] shrink-0 sm:block">
                  <DotMatrix seed={feature.seed} />
                </div>
              </div>
            ))}
          </div>
        </SectionCard>
      </Reveal>
    </SectionShell>
  );
}
