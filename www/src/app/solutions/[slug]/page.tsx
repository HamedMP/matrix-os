import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRightIcon, CheckCircle2Icon } from "lucide-react";
import { getSolution, solutionPages } from "../data";
import { SiteHeader } from "@/components/landing/SiteHeader";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { CtaButton, PageHero, SectionCard, SectionShell, SectionTitle } from "@/components/landing/primitives";
import { Reveal } from "@/components/landing/Reveal";
import { palette as c, cardShadowSmall, fonts } from "@/components/landing/theme";

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
    <div style={{ backgroundColor: c.pageBg, color: c.deep, fontFamily: fonts.sans }}>
      <SiteHeader />
      <main>
        <PageHero eyebrow={page.eyebrow} title={page.title} sub={page.description}>
          <CtaButton href={page.ctaHref}>
            {page.ctaLabel} <ArrowRightIcon className="size-4" />
          </CtaButton>
          <CtaButton href="/solutions" variant="outline">
            All solutions
          </CtaButton>
        </PageHero>

        <SectionShell className="pt-16 md:pt-24">
          <Reveal>
            <SectionCard>
              <div className="px-7 pt-9 pb-8 md:px-12 md:pt-12 md:pb-10" style={{ borderBottom: `1px solid ${c.border}` }}>
                <SectionTitle title="Who it's for." continuation={page.audience} />
              </div>
              <div className="grid md:grid-cols-2">
                <div className="border-b px-7 py-9 md:border-r md:border-b-0 md:px-12 md:py-12" style={{ borderColor: c.border }}>
                  <h2 className="text-[1.0625rem] font-medium" style={{ color: c.deep }}>The problem</h2>
                  <p className="mt-3 text-[0.9375rem] leading-[1.7]" style={{ color: c.mutedFg }}>{page.problem}</p>
                </div>
                <div className="px-7 py-9 md:px-12 md:py-12" style={{ backgroundColor: "rgba(67,78,63,0.04)" }}>
                  <h2 className="text-[1.0625rem] font-medium" style={{ color: c.deep }}>The Matrix answer</h2>
                  <p className="mt-3 text-[0.9375rem] leading-[1.7]" style={{ color: c.mutedFg }}>{page.answer}</p>
                </div>
              </div>
            </SectionCard>
          </Reveal>
        </SectionShell>

        <SectionShell className="pt-16 md:pt-24">
          <Reveal>
            <SectionCard>
              <div className="px-7 pt-9 pb-8 md:px-12 md:pt-12 md:pb-10" style={{ borderBottom: `1px solid ${c.border}` }}>
                <SectionTitle title="What Matrix makes possible." />
              </div>
              <div className="grid md:grid-cols-2">
                {page.outcomes.map((outcome, index) => {
                  const isLastRow = index >= page.outcomes.length - 2;
                  return (
                    <div
                      key={outcome}
                      className={`flex items-start gap-3.5 px-7 py-6 md:px-12 md:py-8 ${index < page.outcomes.length - 1 ? "border-b" : ""} ${isLastRow ? "md:border-b-0" : "md:border-b"} ${index % 2 === 0 ? "md:border-r" : ""}`}
                      style={{ borderColor: c.border }}
                    >
                      <CheckCircle2Icon className="mt-0.5 size-4 shrink-0" style={{ color: c.forest }} aria-hidden="true" />
                      <p className="text-[0.9375rem] leading-[1.6]" style={{ color: c.mutedFg }}>{outcome}</p>
                    </div>
                  );
                })}
              </div>
            </SectionCard>
          </Reveal>
        </SectionShell>

        <SectionShell className="pt-16 md:pt-24">
          <Reveal>
            <SectionCard>
              <div className="px-7 pt-9 pb-8 md:px-12 md:pt-12 md:pb-10" style={{ borderBottom: `1px solid ${c.border}` }}>
                <SectionTitle title="How it runs." continuation="Example workflows, and why Matrix fits them." />
              </div>
              <div className="grid md:grid-cols-2">
                <div className="border-b px-7 py-9 md:border-r md:border-b-0 md:px-12 md:py-12" style={{ borderColor: c.border }}>
                  <h2 className="text-[0.8125rem] font-medium" style={{ color: c.subtle }}>Example workflows</h2>
                  <ul className="mt-5">
                    {page.workflows.map((workflow, index) => (
                      <li
                        key={workflow}
                        className={`py-4 text-[0.9375rem] leading-[1.6] ${index < page.workflows.length - 1 ? "border-b" : ""}`}
                        style={{ color: c.mutedFg, borderColor: c.border }}
                      >
                        {workflow}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="px-7 py-9 md:px-12 md:py-12">
                  <h2 className="text-[0.8125rem] font-medium" style={{ color: c.subtle }}>Why Matrix</h2>
                  <ul className="mt-5">
                    {page.proofPoints.map((point, index) => (
                      <li
                        key={point}
                        className={`flex items-start gap-3 py-4 text-[0.9375rem] leading-[1.6] ${index < page.proofPoints.length - 1 ? "border-b" : ""}`}
                        style={{ color: c.mutedFg, borderColor: c.border }}
                      >
                        <span className="mt-2 size-1.5 shrink-0 rounded-full" style={{ backgroundColor: c.ember }} />
                        {point}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </SectionCard>
          </Reveal>
        </SectionShell>

        <SectionShell className="pt-16 md:pt-24">
          <Reveal>
            <div
              className="flex flex-col items-start gap-6 rounded-2xl px-7 py-10 md:flex-row md:items-center md:justify-between md:px-12 md:py-12"
              style={{ backgroundColor: c.forestDeep, color: "#F4F2E6" }}
            >
              <div>
                <h2 className="text-[1.75rem] leading-[1.15] md:text-[2.25rem]" style={{ fontFamily: fonts.display, fontWeight: 400 }}>
                  Put the agent on its own computer
                </h2>
                <p className="mt-3 max-w-xl text-[0.9375rem] leading-[1.6]" style={{ color: "rgba(244,242,230,0.72)" }}>
                  Start with a hosted Matrix computer, then bring the coding agents, Hermes
                  workflows, connected tools, and teammates you need.
                </p>
              </div>
              <Link
                href={page.ctaHref}
                className="inline-flex shrink-0 items-center gap-2 rounded-[0.625rem] px-5 py-3.5 text-[0.9375rem] font-medium leading-none transition-opacity hover:opacity-85"
                style={{ backgroundColor: "#F4F2E6", color: c.forestDeep }}
              >
                {page.ctaLabel} <ArrowRightIcon className="size-4" />
              </Link>
            </div>
          </Reveal>

          {relatedPages.length > 0 ? (
            <div className="mt-12 md:mt-16">
              <Reveal>
                <div className="mb-7">
                  <SectionTitle title="Related solutions." />
                </div>
              </Reveal>
              <div className="grid gap-5 md:grid-cols-3">
                {relatedPages.map((relatedPage, index) => (
                  <Reveal key={relatedPage.slug} delay={(index % 3) * 90}>
                    <Link
                      href={`/solutions/${relatedPage.slug}`}
                      className="group flex h-full flex-col rounded-2xl p-7 transition-transform duration-300 hover:-translate-y-1"
                      style={{ backgroundColor: c.card, boxShadow: cardShadowSmall }}
                    >
                      <p className="mb-3 text-[0.8125rem] font-medium" style={{ color: c.subtle }}>{relatedPage.eyebrow}</p>
                      <h3 className="text-[1.0625rem] font-medium leading-[1.3]" style={{ color: c.deep }}>{relatedPage.title}</h3>
                      <span className="mt-auto inline-flex items-center gap-1.5 pt-6 text-[0.9375rem] font-medium" style={{ color: c.forest }}>
                        Read page
                        <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
                      </span>
                    </Link>
                  </Reveal>
                ))}
              </div>
            </div>
          ) : null}
        </SectionShell>
      </main>
      <SiteFooter />
    </div>
  );
}
