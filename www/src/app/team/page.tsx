import type { Metadata } from "next";
import Image from "next/image";
import { LinkedinIcon, XIcon } from "lucide-react";
import { SiteHeader } from "@/components/landing/SiteHeader";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { SectionShell } from "@/components/landing/primitives";
import { palette as c, fonts, cardShadowSmall } from "@/components/landing/theme";

export const metadata: Metadata = {
  title: "Team | Matrix OS",
  description: "Meet the founders building Matrix OS.",
  openGraph: {
    title: "Team | Matrix OS",
    description: "Meet the founders building Matrix OS.",
    url: "https://matrix-os.com/team",
    siteName: "Matrix OS",
    type: "website",
  },
};

const founders = [
  {
    name: "Hamed Mohammadpour",
    role: "CEO & Co-Founder",
    bio: "Hamed brings product and machine-learning instincts from PostHog and Newly, with a Machine Learning Engineering background from KTH. He focuses on making Matrix OS useful in real workflows: clear, fast, and grounded in how people actually build.",
    linkedin: "https://www.linkedin.com/in/hamedmohammadpour/",
    x: "https://x.com/thehamedmp",
  },
  {
    name: "Nima Naderi",
    role: "CTO & Co-Founder",
    bio: "Nima brings product engineering experience from Bending Spoons, a Computer Engineering background from Polito, and Olympiad gold-medal problem solving. He focuses on the technical foundation of Matrix OS: reliable systems, polished interfaces, and the details that make AI feel native.",
    linkedin: "https://www.linkedin.com/in/nima-naderi04/",
    x: "https://x.com/NimaNaderi2004",
  },
] as const;

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
              <p className="mt-5 text-[1.0625rem] leading-[1.7]" style={{ color: c.mutedFg }}>
                We are building Matrix OS as an AI-native computer where apps, files, messages, and agents work
                together in one workspace. Our founding team combines machine learning, product engineering, and
                high-craft consumer software experience.
              </p>

              <div className="mt-9 space-y-7">
                {founders.map((founder) => (
                  <article key={founder.name} className="border-t pt-6" style={{ borderColor: c.border }}>
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex shrink-0 items-center gap-2">
                        <a
                          href={founder.linkedin}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`${founder.name} on LinkedIn`}
                          className="flex h-8 w-8 items-center justify-center rounded-lg border transition hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-offset-2"
                          style={{
                            backgroundColor: c.card,
                            borderColor: c.border,
                            color: c.forestDeep,
                            boxShadow: "0 0.5rem 1.25rem rgba(50, 53, 46, 0.06)",
                            ["--tw-ring-color" as string]: c.forest,
                            ["--tw-ring-offset-color" as string]: c.pageBg,
                          }}
                        >
                          <LinkedinIcon aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
                        </a>
                        <a
                          href={founder.x}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`${founder.name} on X`}
                          className="flex h-8 w-8 items-center justify-center rounded-lg border transition hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-offset-2"
                          style={{
                            backgroundColor: c.card,
                            borderColor: c.border,
                            color: c.forestDeep,
                            boxShadow: "0 0.5rem 1.25rem rgba(50, 53, 46, 0.06)",
                            ["--tw-ring-color" as string]: c.forest,
                            ["--tw-ring-offset-color" as string]: c.pageBg,
                          }}
                        >
                          <XIcon aria-hidden="true" className="h-4 w-4" strokeWidth={2} />
                        </a>
                      </div>
                      <h2 className="text-[1.25rem] font-medium leading-[1.25]" style={{ color: c.deep }}>
                        {founder.name}
                      </h2>
                    </div>
                    <p className="mt-2 text-[0.9375rem] font-medium" style={{ color: c.forest }}>
                      {founder.role}
                    </p>
                    <p className="mt-3 text-[1rem] leading-[1.7]" style={{ color: c.mutedFg }}>
                      {founder.bio}
                    </p>
                  </article>
                ))}
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
