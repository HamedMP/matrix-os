import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BotIcon,
  BriefcaseBusinessIcon,
  CloudIcon,
  GraduationCapIcon,
  ShieldCheckIcon,
  SparklesIcon,
  TerminalIcon,
} from "lucide-react";
import { solutionPages } from "../solutions/data";

const c = {
  forest: "#434E3F",
  deep: "#32352E",
  ember: "#D06F25",
  pageBg: "#E2E2CF",
  border: "#D6D3C8",
  mutedFg: "#5C5A4F",
  subtle: "#7A7768",
} as const;

export const metadata: Metadata = {
  title: "Matrix OS Use Cases",
  description:
    "Explore Matrix OS use cases for cloud-native development, professional AI assistants, Hermes hosting, enterprise AI experimentation, universities, and always-on cloud computers.",
  openGraph: {
    title: "Matrix OS Use Cases",
    description:
      "Explore Matrix OS use cases for cloud-native development, professional AI assistants, Hermes hosting, enterprise AI experimentation, universities, and always-on cloud computers.",
    url: "https://matrix-os.com/use-cases",
    siteName: "Matrix OS",
    type: "website",
  },
};

const primaryUseCases = [
  {
    id: "developers",
    Icon: TerminalIcon,
    label: "Primary ICP",
    title: "Developers running autonomous coding agents",
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
    desc: "Use Matrix as an always-on assistant for research, planning, meeting prep, follow-ups, reports, inbox triage, dashboards, and documents. Hermes can work across connected tools while your context stays in one workspace.",
  },
  {
    id: "hermes-hosting",
    Icon: BotIcon,
    title: "Easy hosting for Hermes",
    desc: "Host the Matrix-native agent without standing up your own server. Hermes gets a persistent computer, scheduled workflows, connected tools, approval prompts, notifications, and memory.",
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
    <main
      className="min-h-screen overflow-hidden"
      style={{ backgroundColor: c.pageBg, color: c.deep, fontFamily: "var(--font-inter), Inter, system-ui, sans-serif" }}
    >
      <UseCasesNav />

      <section className="pt-32 pb-14 md:pt-36 md:pb-20">
        <div className="mx-auto max-w-[1100px] px-6 md:px-8">
          <div className="max-w-3xl">
            <Link
              href="/"
              className="mb-8 inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] transition-opacity hover:opacity-70"
              style={{ color: c.subtle }}
            >
              <ArrowLeftIcon className="size-3.5" />
              Back home
            </Link>
            <p className="text-[11px] font-medium uppercase tracking-[0.3em]" style={{ color: c.subtle }}>
              Use cases
            </p>
            <h1 className="mt-5 max-w-2xl text-[clamp(2.45rem,6vw,4.4rem)] font-normal leading-[1.05]" style={{ color: c.forest }}>
              Start with cloud-native development. Expand into the cloud computer.
            </h1>
            <p className="mt-6 max-w-2xl text-[16px] leading-[1.85]" style={{ color: c.mutedFg }}>
              Matrix OS is focused first on developers. The same always-on computer also supports professional assistants, hosted Hermes workflows, OpenClaw-style agents, secure AI experimentation, and university labs.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1100px] px-6 pb-14 md:px-8 md:pb-20">
        <div className="grid gap-4 md:grid-cols-3">
          {primaryUseCases.map((item) => (
            <article
              key={item.id}
              id={item.id}
              className="flex min-h-[24rem] scroll-mt-24 flex-col rounded-[18px] p-6"
              style={{ backgroundColor: "rgba(250,250,245,0.42)", border: `1px solid ${c.border}` }}
            >
              <span className="mb-6 grid size-11 place-items-center rounded-full" style={{ backgroundColor: "rgba(208,111,37,0.1)", color: c.ember }}>
                <item.Icon className="size-5" />
              </span>
              <p className="mb-4 text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: c.ember }}>{item.label}</p>
              <h2 className="text-[1.05rem] font-semibold leading-[1.25]" style={{ color: c.forest }}>{item.title}</h2>
              <p className="mt-4 text-[13px] leading-[1.7]" style={{ color: c.mutedFg }}>{item.desc}</p>
              <ul className="mt-5 grid gap-2 text-[13px]" style={{ color: c.mutedFg }}>
                {item.bullets.map((bullet) => (
                  <li key={bullet} className="flex gap-2">
                    <span className="mt-2 size-1.5 shrink-0 rounded-full" style={{ backgroundColor: c.ember }} />
                    {bullet}
                  </li>
                ))}
              </ul>
              <Link
                href={item.href}
                className="mt-auto inline-flex items-center gap-2 pt-7 text-[11px] font-semibold uppercase tracking-[0.12em] transition-opacity hover:opacity-70"
                style={{ color: c.forest }}
              >
                {item.cta} <ArrowRightIcon className="size-3.5" />
              </Link>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-[1100px] px-6 pb-14 md:px-8 md:pb-20">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.3em]" style={{ color: c.subtle }}>
              Solution pages
            </p>
            <h2 className="text-[clamp(1.85rem,4vw,3.2rem)] font-normal leading-[1.1]" style={{ color: c.forest }}>
              More ways to use a Matrix cloud computer
            </h2>
          </div>
          <Link
            href="/solutions"
            className="inline-flex min-h-11 items-center gap-2 rounded-full px-5 text-[11px] font-semibold uppercase tracking-[0.12em] transition-opacity hover:opacity-80"
            style={{ backgroundColor: c.forest, color: c.pageBg }}
          >
            View all <ArrowRightIcon className="size-3.5" />
          </Link>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {solutionPages.slice(0, 6).map((page) => (
            <Link key={page.slug} href={`/solutions/${page.slug}`} className="rounded-[16px] p-5 transition-opacity hover:opacity-80" style={{ backgroundColor: "rgba(250,250,245,0.42)", border: `1px solid ${c.border}` }}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: c.ember }}>{page.eyebrow}</p>
              <h3 className="mt-3 text-[15px] font-semibold leading-[1.25]" style={{ color: c.forest }}>{page.title}</h3>
            </Link>
          ))}
        </div>
      </section>

      <section className="py-14 md:py-20" style={{ borderTop: `1px solid ${c.border}`, borderBottom: `1px solid ${c.border}`, backgroundColor: "rgba(250,250,245,0.22)" }}>
        <div className="mx-auto grid max-w-[1100px] gap-8 px-6 md:grid-cols-[0.9fr_1.1fr] md:px-8">
          <div>
            <p className="mb-5 text-[11px] font-medium uppercase tracking-[0.3em]" style={{ color: c.subtle }}>
              The broader platform
            </p>
            <h2 className="text-[clamp(1.85rem,4vw,3.2rem)] font-normal leading-[1.1]" style={{ color: c.forest }}>
              Not every Matrix buyer starts with code.
            </h2>
            <p className="mt-5 text-[15px] leading-[1.85]" style={{ color: c.mutedFg }}>
              Some teams need a secure place to experiment. Some universities need a standard lab. Some professionals want an assistant that can use real tools. Matrix keeps those workflows in one persistent environment.
            </p>
          </div>
          <div className="grid gap-3">
            {broaderUseCases.map((item) => (
              <article key={item.id} id={item.id} className="scroll-mt-24 rounded-[16px] p-5" style={{ backgroundColor: "rgba(250,250,245,0.42)", border: `1px solid ${c.border}` }}>
                <div className="grid grid-cols-[2.4rem_1fr] gap-4">
                  <span className="grid size-10 place-items-center rounded-full" style={{ backgroundColor: "rgba(208,111,37,0.1)", color: c.ember }}>
                    <item.Icon className="size-4" />
                  </span>
                  <div>
                    <h3 className="text-[15px] font-semibold" style={{ color: c.forest }}>{item.title}</h3>
                    <p className="mt-2 text-[13px] leading-[1.7]" style={{ color: c.mutedFg }}>{item.desc}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1100px] px-6 py-14 md:px-8 md:py-20">
        <div className="rounded-[22px] p-7 sm:p-10 md:p-12" style={{ backgroundColor: "rgba(50,53,46,0.9)", border: `1px solid ${c.border}`, color: c.pageBg }}>
          <div className="grid gap-8 md:grid-cols-[1fr_auto] md:items-center">
            <div>
              <p className="mb-4 text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "rgba(226,226,207,0.62)" }}>
                Pilots
              </p>
              <h2 className="text-[clamp(1.85rem,4vw,3.2rem)] font-normal leading-[1.1]">
                Evaluating Matrix for a company or university?
              </h2>
              <p className="mt-4 max-w-2xl text-[13px] leading-[1.75]" style={{ color: "rgba(226,226,207,0.72)" }}>
                Share the audience, constraints, region, and first workflow. We will help map the right pilot path.
              </p>
            </div>
            <Link
              href="/contact"
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-6 text-[11px] font-semibold uppercase tracking-[0.12em] transition-opacity hover:opacity-85"
              style={{ backgroundColor: c.pageBg, color: c.forest }}
            >
              Contact us <ArrowRightIcon className="size-3.5" />
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}

function UseCasesNav() {
  return (
    <div className="fixed left-1/2 top-5 z-50 w-fit max-w-[calc(100vw-1rem)] -translate-x-1/2">
      <div
        className="flex min-h-12 items-center gap-2 rounded-full px-3 shadow-[0_12px_32px_rgba(50,53,46,0.08)] backdrop-blur-md"
        style={{ backgroundColor: "rgba(250,250,245,0.86)", border: `1px solid ${c.border}` }}
      >
        <Link href="/" className="inline-flex min-h-8 items-center gap-2 rounded-full px-2.5 text-[12px] font-medium transition-opacity hover:opacity-75" style={{ color: c.forest }}>
          <Image src="/rabbit.svg" alt="Matrix OS" width={20} height={26} className="h-6 w-auto" />
          <span>Matrix OS</span>
        </Link>
        <Link
          href="/contact"
          className="inline-flex min-h-8 items-center rounded-full px-3 text-[10px] font-semibold uppercase tracking-[0.12em] transition-opacity hover:opacity-85"
          style={{ backgroundColor: c.forest, color: c.pageBg }}
        >
          Contact
        </Link>
      </div>
    </div>
  );
}
