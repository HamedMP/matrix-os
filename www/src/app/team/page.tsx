import type { Metadata } from "next";
import Image from "next/image";
import { SiteHeader } from "@/components/landing/SiteHeader";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { SectionShell } from "@/components/landing/primitives";
import { palette as c, fonts, cardShadowSmall } from "@/components/landing/theme";

export const metadata: Metadata = {
  title: "Team | Matrix OS",
  description: "Meet the team building Matrix OS.",
  openGraph: {
    title: "Team | Matrix OS",
    description: "Meet the team building Matrix OS.",
    url: "https://matrix-os.com/team",
    siteName: "Matrix OS",
    type: "website",
  },
};

export default function TeamPage() {
  return (
    <div style={{ backgroundColor: c.pageBg, color: c.deep, fontFamily: fonts.sans }}>
      <SiteHeader />
      <main>
        <SectionShell className="pt-10 pb-16 md:pt-20 md:pb-24">
          <div className="grid items-center gap-10 lg:grid-cols-[0.82fr_1.18fr] lg:gap-14">
            <section aria-labelledby="team-heading" className="max-w-[34rem]">
              <p className="mb-5 text-[0.9375rem]" style={{ fontFamily: fonts.display, color: c.subtle }}>
                Team
              </p>
              <h1
                id="team-heading"
                className="text-[2.5rem] leading-[1.08] tracking-[-0.01em] md:text-[3.5rem]"
                style={{ fontFamily: fonts.display, color: c.deep, fontWeight: 400 }}
              >
                Building Matrix OS
              </h1>

              <div className="mt-9 space-y-7">
                <article className="border-t pt-6" style={{ borderColor: c.border }}>
                  <h2 className="text-[1.25rem] font-medium leading-[1.25]" style={{ color: c.deep }}>
                    Hamed Mohammadpour
                  </h2>
                  <p className="mt-1 text-[0.9375rem] font-medium" style={{ color: c.forest }}>
                    CEO & Co-Founder
                  </p>
                  <p className="mt-3 text-[1rem] leading-[1.7]" style={{ color: c.mutedFg }}>
                    Ex-PostHog, Ex-Newly. Studied Machine Learning Engineering at KTH.
                  </p>
                </article>

                <article className="border-t pt-6" style={{ borderColor: c.border }}>
                  <h2 className="text-[1.25rem] font-medium leading-[1.25]" style={{ color: c.deep }}>
                    Nima Naderi
                  </h2>
                  <p className="mt-1 text-[0.9375rem] font-medium" style={{ color: c.forest }}>
                    CTO & Co-Founder
                  </p>
                  <p className="mt-3 text-[1rem] leading-[1.7]" style={{ color: c.mutedFg }}>
                    Ex-Bending Spoons. Studied Computer Engineering at Polito. Olympiad Gold Medalist.
                  </p>
                </article>
              </div>
            </section>

            <div
              className="overflow-hidden rounded-2xl"
              style={{ backgroundColor: c.card, boxShadow: cardShadowSmall }}
            >
              <Image
                src="/images/team-founders.jpg"
                alt="Matrix OS co-founders Nima Naderi and Hamed Mohammadpour"
                width={2400}
                height={1692}
                priority
                className="h-auto w-full"
                sizes="(min-width: 1024px) 56vw, 100vw"
              />
            </div>
          </div>
        </SectionShell>
      </main>
      <SiteFooter />
    </div>
  );
}
