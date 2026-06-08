import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeftIcon, ArrowRightIcon, CloudIcon } from "lucide-react";
import { solutionPages } from "./data";

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
  title: "Matrix OS Solutions",
  description:
    "Explore Matrix OS solutions for cloud computers, AI coding agents, Hermes hosting, OpenClaw-style agents, enterprise AI labs, university labs, and professional assistants.",
  openGraph: {
    title: "Matrix OS Solutions",
    description:
      "Explore Matrix OS solutions for cloud computers, AI coding agents, Hermes hosting, OpenClaw-style agents, enterprise AI labs, university labs, and professional assistants.",
    url: "https://matrix-os.com/solutions",
    siteName: "Matrix OS",
    type: "website",
  },
};

export default function SolutionsPage() {
  return (
    <main
      className="min-h-screen overflow-hidden"
      style={{ backgroundColor: c.pageBg, color: c.deep, fontFamily: "var(--font-inter), Inter, system-ui, sans-serif" }}
    >
      <SolutionNav />

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
              Solutions
            </p>
            <h1 className="mt-5 max-w-2xl text-[clamp(2.45rem,6vw,4.4rem)] font-normal leading-[1.05]" style={{ color: c.forest }}>
              One cloud computer. Many agent workflows.
            </h1>
            <p className="mt-6 max-w-2xl text-[16px] leading-[1.85]" style={{ color: c.mutedFg }}>
              Matrix OS gives developers and teams a hosted computer where coding agents, Hermes, OpenClaw-style agents, tools, files, terminals, previews, and workflows can keep running.
            </p>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1100px] px-6 pb-16 md:px-8 md:pb-24">
        <div className="grid gap-4 md:grid-cols-3">
          {solutionPages.map((page) => (
            <Link
              key={page.slug}
              href={`/solutions/${page.slug}`}
              className="group flex min-h-[16.5rem] flex-col rounded-[18px] p-5 transition-transform duration-300 hover:-translate-y-0.5"
              style={{ backgroundColor: "rgba(250,250,245,0.42)", border: `1px solid ${c.border}` }}
            >
              <span className="mb-5 grid size-10 place-items-center rounded-full" style={{ backgroundColor: "rgba(208,111,37,0.1)", color: c.ember }}>
                <CloudIcon className="size-5" />
              </span>
              <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: c.ember }}>{page.eyebrow}</p>
              <h2 className="text-[1.05rem] font-semibold leading-[1.25]" style={{ color: c.forest }}>{page.title}</h2>
              <p className="mt-3 text-[13px] leading-[1.7]" style={{ color: c.mutedFg }}>{page.description}</p>
              <span className="mt-auto inline-flex items-center gap-2 pt-6 text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: c.forest }}>
                Read solution <ArrowRightIcon className="size-3.5 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
}

function SolutionNav() {
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
          href="/docs/users/quickstart"
          className="inline-flex min-h-8 items-center rounded-full px-3 text-[10px] font-semibold uppercase tracking-[0.12em] transition-opacity hover:opacity-85"
          style={{ backgroundColor: c.forest, color: c.pageBg }}
        >
          Quickstart
        </Link>
      </div>
    </div>
  );
}
