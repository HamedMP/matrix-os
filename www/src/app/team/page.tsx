import type { Metadata } from "next";
import Image from "next/image";
import { LinkedinIcon } from "lucide-react";
import { SiteHeader } from "@/components/landing/SiteHeader";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { SectionShell } from "@/components/landing/primitives";
import { palette as c, fonts, cardShadowSmall } from "@/components/landing/theme";

export const metadata: Metadata = {
  title: "About us | Matrix OS",
  description: "Meet the founders and mission behind Matrix OS.",
  openGraph: {
    title: "About us | Matrix OS",
    description: "Meet the founders and mission behind Matrix OS.",
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
    logos: [
      { src: "/images/team/posthog-logo.png", alt: "PostHog", width: 120, height: 23, className: "h-7 w-auto max-w-40" },
      { src: "/images/team/newly-logo.jpg", alt: "Newly", width: 56, height: 56, className: "h-12 w-auto rounded-[4px] max-w-14" },
      { src: "/images/team/kth-logo.svg", alt: "KTH", width: 82, height: 92, className: "h-16 w-auto max-w-24" },
    ],
    linkedin: "https://www.linkedin.com/in/hamedmohammadpour/",
    x: "https://x.com/thehamedmp",
  },
  {
    name: "Nima Naderi",
    role: "CTO & Co-Founder",
    bio: "Nima brings product engineering experience from Bending Spoons, a Computer Engineering background from Polito, and Olympiad gold-medal problem solving. He focuses on the technical foundation of Matrix OS: reliable systems, polished interfaces, and the details that make AI feel native.",
    logos: [
      { src: "/images/team/ioi-logo.png", alt: "International Olympiad in Informatics", width: 78, height: 78, className: "h-16 w-auto max-w-20" },
      { src: "/images/team/bending-spoons-logo.svg", alt: "Bending Spoons", width: 198, height: 80, className: "h-12 w-auto max-w-56" },
    ],
    linkedin: "https://www.linkedin.com/in/nima-naderi04/",
    x: "https://x.com/NimaNaderi2004",
  },
] as const;

function XLogoIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className={className} fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export default function TeamPage() {
  return (
    <div style={{ backgroundColor: c.pageBg, color: c.deep, fontFamily: fonts.sans }}>
      <SiteHeader />
      <main>
        <SectionShell className="pt-10 pb-16 md:pt-20 md:pb-24">
          <section aria-labelledby="team-heading" className="mx-auto max-w-[50rem] text-center">
            <p
              className="mb-5 text-[1.625rem] leading-[1.12] md:text-[1.875rem]"
              style={{ fontFamily: fonts.display, color: c.mutedFg }}
            >
              Mission
            </p>
            <h1
              id="team-heading"
              className="text-[2.5rem] leading-[1.08] tracking-[-0.01em] md:text-[3.5rem]"
              style={{ fontFamily: fonts.display, color: c.deep, fontWeight: 400 }}
            >
              Building Matrix OS
            </h1>
            <p className="mt-6 text-[1.0625rem] leading-[1.75]" style={{ color: c.mutedFg }}>
              Our mission is to give everyone a personal computer in the cloud where their AI agents live, keep
              context, and work 24/7. We combine Hamed&apos;s product instinct with Nima&apos;s engineering and
              security depth to make always-on agents useful without buying hardware or babysitting infrastructure.
            </p>
          </section>

          <div className="mt-12 grid items-start gap-10 lg:grid-cols-[0.82fr_1.18fr] lg:gap-14">
            <section aria-label="Founders" className="max-w-[34rem]">
              <h2
                className="text-[1.75rem] leading-[1.15] md:text-[2rem]"
                style={{ fontFamily: fonts.display, color: c.deep, fontWeight: 400 }}
              >
                Meet our founders
              </h2>
              <div className="space-y-7">
                {founders.map((founder) => (
                  <article key={founder.name} className="border-t pt-6" style={{ borderColor: c.border }}>
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
                      <h2 className="text-[1.25rem] font-medium leading-[1.25]" style={{ color: c.deep }}>
                        {founder.name}
                      </h2>
                      <span aria-hidden="true" className="hidden text-[1.25rem] leading-none sm:inline" style={{ color: c.subtle }}>
                        |
                      </span>
                      <p className="text-[1.25rem] font-medium leading-[1.25]" style={{ color: c.forestDeep }}>
                        {founder.role}
                      </p>
                      <div className="flex shrink-0 items-center gap-2 pl-1">
                        <a
                          href={founder.linkedin}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`${founder.name} on LinkedIn`}
                          className="inline-flex h-6 w-6 items-center justify-center transition hover:-translate-y-0.5 hover:opacity-75 focus:outline-none focus:ring-2 focus:ring-offset-2"
                          style={{
                            color: c.subtle,
                            ["--tw-ring-color" as string]: c.forest,
                            ["--tw-ring-offset-color" as string]: c.pageBg,
                          }}
                        >
                          <LinkedinIcon aria-hidden="true" className="h-4.5 w-4.5" strokeWidth={2} />
                        </a>
                        <a
                          href={founder.x}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`${founder.name} on X`}
                          className="inline-flex h-6 w-6 items-center justify-center transition hover:-translate-y-0.5 hover:opacity-75 focus:outline-none focus:ring-2 focus:ring-offset-2"
                          style={{
                            color: c.subtle,
                            ["--tw-ring-color" as string]: c.forest,
                            ["--tw-ring-offset-color" as string]: c.pageBg,
                          }}
                        >
                          <XLogoIcon className="h-4 w-4" />
                        </a>
                      </div>
                    </div>
                    <p className="mt-3 text-[1rem] leading-[1.7]" style={{ color: c.mutedFg }}>
                      {founder.bio}
                    </p>
                    <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
                      {founder.logos.map((logo) => (
                        <Image
                          key={logo.src}
                          src={logo.src}
                          alt={logo.alt}
                          width={logo.width}
                          height={logo.height}
                          className={`object-contain ${logo.className}`}
                        />
                      ))}
                    </div>
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
                width={1500}
                height={1125}
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
