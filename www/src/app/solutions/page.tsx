import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { solutionPages } from "./data";
import { SiteHeader } from "@/components/landing/SiteHeader";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { FinalCtaSection } from "@/components/landing/FinalCtaSection";
import { CtaButton, PageHero, SectionShell } from "@/components/landing/primitives";
import { Reveal } from "@/components/landing/Reveal";
import { palette as c, cardShadowSmall, fonts } from "@/components/landing/theme";

export const metadata: Metadata = {
  title: "Matrix OS Solutions",
  description:
    "Explore Matrix OS solutions for cloud computers, background coding agents, Hermes hosting, OpenClaw-style agents, enterprise AI labs, university labs, and professional assistants.",
  openGraph: {
    title: "Matrix OS Solutions",
    description:
      "Explore Matrix OS solutions for cloud computers, background coding agents, Hermes hosting, OpenClaw-style agents, enterprise AI labs, university labs, and professional assistants.",
    url: "https://matrix-os.com/solutions",
    siteName: "Matrix OS",
    type: "website",
  },
};

export default function SolutionsPage() {
  return (
    <div style={{ backgroundColor: c.pageBg, color: c.deep, fontFamily: fonts.sans }}>
      <SiteHeader />
      <main>
        <PageHero
          eyebrow="Solutions"
          title={
            <>
              One cloud computer.
              <br />
              Many agent workflows.
            </>
          }
          sub="A hosted computer where background coding agents, Hermes, tools, files, terminals, previews, and workflows keep running."
        >
          <CtaButton href="https://app.matrix-os.com" phLocation="solutions_hero" phTarget="start_cloud_dev">
            Get started
          </CtaButton>
          <CtaButton href="/docs/quickstart" variant="outline">
            Read quickstart
          </CtaButton>
        </PageHero>

        <SectionShell className="pt-16 md:pt-24">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {solutionPages.map((page, index) => (
              <Reveal key={page.slug} delay={(index % 3) * 90}>
                <Link
                  href={`/solutions/${page.slug}`}
                  className="group flex h-full min-h-[16rem] flex-col rounded-2xl p-7 transition-transform duration-300 hover:-translate-y-1"
                  style={{ backgroundColor: c.card, boxShadow: cardShadowSmall }}
                >
                  <p className="mb-3 text-[0.8125rem] font-medium" style={{ color: c.subtle }}>{page.eyebrow}</p>
                  <h2 className="mb-3 text-[1.0625rem] font-medium leading-[1.3]" style={{ color: c.deep }}>
                    {page.title}
                  </h2>
                  <p className="line-clamp-3 text-[0.9375rem] leading-[1.6]" style={{ color: c.mutedFg }}>
                    {page.description}
                  </p>
                  <span className="mt-auto inline-flex items-center gap-1.5 pt-6 text-[0.9375rem] font-medium" style={{ color: c.forest }}>
                    Read solution
                    <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </Link>
              </Reveal>
            ))}
          </div>
        </SectionShell>

        <FinalCtaSection />
      </main>
      <SiteFooter />
    </div>
  );
}
