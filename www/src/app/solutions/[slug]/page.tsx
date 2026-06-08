import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeftIcon, ArrowRightIcon, CheckCircle2Icon } from "lucide-react";
import { getSolution, solutionPages } from "../data";

const c = {
  forest: "#434E3F",
  deep: "#32352E",
  ember: "#D06F25",
  pageBg: "#E2E2CF",
  border: "#D6D3C8",
  mutedFg: "#5C5A4F",
  subtle: "#7A7768",
} as const;

type PageProps = {
  params: Promise<{ slug: string }>;
};

export function generateStaticParams() {
  return solutionPages.map((page) => ({ slug: page.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = getSolution(slug);
  if (!page) return {};

  return {
    title: page.metaTitle,
    description: page.description,
    openGraph: {
      title: page.metaTitle,
      description: page.description,
      url: `https://matrix-os.com/solutions/${page.slug}`,
      siteName: "Matrix OS",
      type: "website",
    },
  };
}

export default async function SolutionDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const page = getSolution(slug);
  if (!page) notFound();

  const relatedPages = page.related
    .map((relatedSlug) => getSolution(relatedSlug))
    .filter((relatedPage): relatedPage is NonNullable<typeof relatedPage> => Boolean(relatedPage));

  return (
    <main
      className="min-h-screen overflow-hidden"
      style={{ backgroundColor: c.pageBg, color: c.deep, fontFamily: "var(--font-inter), Inter, system-ui, sans-serif" }}
    >
      <SolutionDetailNav />

      <section className="pt-32 pb-14 md:pt-36 md:pb-20">
        <div className="mx-auto max-w-[1100px] px-6 md:px-8">
          <div className="grid gap-8 md:grid-cols-[0.96fr_1.04fr] md:items-end">
            <div>
              <Link
                href="/solutions"
                className="mb-8 inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] transition-opacity hover:opacity-70"
                style={{ color: c.subtle }}
              >
                <ArrowLeftIcon className="size-3.5" />
                All solutions
              </Link>
              <p className="text-[11px] font-medium uppercase tracking-[0.3em]" style={{ color: c.subtle }}>
                {page.eyebrow}
              </p>
              <h1 className="mt-5 text-[clamp(2.25rem,5.5vw,4.1rem)] font-normal leading-[1.05]" style={{ color: c.forest }}>
                {page.title}
              </h1>
            </div>
            <div className="rounded-[18px] p-6" style={{ backgroundColor: "rgba(250,250,245,0.42)", border: `1px solid ${c.border}` }}>
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: c.ember }}>
                Who it is for
              </p>
              <p className="mt-4 text-[15px] leading-[1.85]" style={{ color: c.mutedFg }}>
                {page.audience}
              </p>
              <Link
                href={page.ctaHref}
                className="mt-6 inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-5 text-[11px] font-semibold uppercase tracking-[0.12em] transition-opacity hover:opacity-85"
                style={{ backgroundColor: c.forest, color: c.pageBg }}
              >
                {page.ctaLabel} <ArrowRightIcon className="size-3.5" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-[1100px] gap-5 px-6 pb-14 md:grid-cols-2 md:px-8 md:pb-20">
        <article className="rounded-[18px] p-6 md:p-7" style={{ backgroundColor: "rgba(250,250,245,0.42)", border: `1px solid ${c.border}` }}>
          <p className="mb-4 text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: c.ember }}>
            The problem
          </p>
          <p className="text-[15px] leading-[1.85]" style={{ color: c.mutedFg }}>{page.problem}</p>
        </article>
        <article className="rounded-[18px] p-6 md:p-7" style={{ backgroundColor: "rgba(50,53,46,0.9)", border: `1px solid ${c.border}`, color: c.pageBg }}>
          <p className="mb-4 text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "rgba(226,226,207,0.62)" }}>
            Matrix answer
          </p>
          <p className="text-[15px] leading-[1.85]" style={{ color: "rgba(226,226,207,0.78)" }}>{page.answer}</p>
        </article>
      </section>

      <section className="py-14 md:py-20" style={{ borderTop: `1px solid ${c.border}`, borderBottom: `1px solid ${c.border}`, backgroundColor: "rgba(250,250,245,0.22)" }}>
        <div className="mx-auto grid max-w-[1100px] gap-8 px-6 md:grid-cols-[0.88fr_1.12fr] md:px-8">
          <div>
            <p className="mb-5 text-[11px] font-medium uppercase tracking-[0.3em]" style={{ color: c.subtle }}>
              Outcomes
            </p>
            <h2 className="text-[clamp(1.85rem,4vw,3.2rem)] font-normal leading-[1.1]" style={{ color: c.forest }}>
              What Matrix makes possible
            </h2>
          </div>
          <div className="grid gap-3">
            {page.outcomes.map((outcome) => (
              <div key={outcome} className="flex gap-3 rounded-[14px] p-4 text-[13px] leading-[1.7]" style={{ backgroundColor: "rgba(250,250,245,0.42)", border: `1px solid ${c.border}`, color: c.mutedFg }}>
                <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" style={{ color: c.ember }} />
                <span>{outcome}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-[1100px] gap-8 px-6 py-14 md:grid-cols-2 md:px-8 md:py-20">
        <div>
          <p className="mb-5 text-[11px] font-medium uppercase tracking-[0.3em]" style={{ color: c.subtle }}>
            Example workflows
          </p>
          <div className="grid gap-3">
            {page.workflows.map((workflow) => (
              <article key={workflow} className="rounded-[14px] p-5" style={{ backgroundColor: "rgba(250,250,245,0.42)", border: `1px solid ${c.border}` }}>
                <p className="text-[13px] leading-[1.7]" style={{ color: c.mutedFg }}>{workflow}</p>
              </article>
            ))}
          </div>
        </div>
        <div>
          <p className="mb-5 text-[11px] font-medium uppercase tracking-[0.3em]" style={{ color: c.subtle }}>
            Why Matrix
          </p>
          <div className="grid gap-3">
            {page.proofPoints.map((point) => (
              <article key={point} className="rounded-[14px] p-5" style={{ backgroundColor: "rgba(250,250,245,0.42)", border: `1px solid ${c.border}` }}>
                <p className="text-[13px] leading-[1.7]" style={{ color: c.mutedFg }}>{point}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1100px] px-6 pb-14 md:px-8 md:pb-20">
        <div className="rounded-[22px] p-7 sm:p-10 md:p-12" style={{ backgroundColor: "rgba(50,53,46,0.9)", border: `1px solid ${c.border}`, color: c.pageBg }}>
          <div className="grid gap-8 md:grid-cols-[1fr_auto] md:items-center">
            <div>
              <p className="mb-4 text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: "rgba(226,226,207,0.62)" }}>
                Next step
              </p>
              <h2 className="text-[clamp(1.85rem,4vw,3.2rem)] font-normal leading-[1.1]">
                Put the agent on its own computer.
              </h2>
              <p className="mt-4 max-w-2xl text-[13px] leading-[1.75]" style={{ color: "rgba(226,226,207,0.72)" }}>
                Start with a hosted Matrix computer, then bring the coding agents, Hermes workflows, connected tools, and teammates you need.
              </p>
            </div>
            <Link
              href={page.ctaHref}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-full px-6 text-[11px] font-semibold uppercase tracking-[0.12em] transition-opacity hover:opacity-85"
              style={{ backgroundColor: c.pageBg, color: c.forest }}
            >
              {page.ctaLabel} <ArrowRightIcon className="size-3.5" />
            </Link>
          </div>
        </div>

        {relatedPages.length > 0 ? (
          <div className="mt-10">
            <p className="mb-4 text-[11px] font-medium uppercase tracking-[0.3em]" style={{ color: c.subtle }}>
              Related solutions
            </p>
            <div className="grid gap-3 md:grid-cols-3">
              {relatedPages.map((relatedPage) => (
                <Link
                  key={relatedPage.slug}
                  href={`/solutions/${relatedPage.slug}`}
                  className="rounded-[16px] p-5 transition-opacity hover:opacity-80"
                  style={{ backgroundColor: "rgba(250,250,245,0.42)", border: `1px solid ${c.border}` }}
                >
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em]" style={{ color: c.ember }}>{relatedPage.eyebrow}</p>
                  <h3 className="mt-3 text-[15px] font-semibold leading-[1.25]" style={{ color: c.forest }}>{relatedPage.title}</h3>
                </Link>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function SolutionDetailNav() {
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
          href="/solutions"
          className="inline-flex min-h-8 items-center rounded-full px-3 text-[10px] font-semibold uppercase tracking-[0.12em] transition-opacity hover:opacity-85"
          style={{ backgroundColor: c.forest, color: c.pageBg }}
        >
          Solutions
        </Link>
      </div>
    </div>
  );
}
