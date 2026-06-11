import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { solutionPages } from "@/app/solutions/data";
import { palette as c, cardShadowSmall, fonts } from "./theme";
import { CtaButton, SectionShell, SectionTitle } from "./primitives";
import { Reveal } from "./Reveal";

const highlightedSolutions = solutionPages.slice(0, 6);

export function SolutionsSection() {
  return (
    <SectionShell id="solutions" className="pt-16 md:pt-28">
      <Reveal>
        <div className="mb-8 max-w-[44rem] md:mb-10">
          <SectionTitle
            title="Same computer. Different jobs."
            continuation="Coding agents, Hermes hosting, enterprise pilots, universities, and professional workflows."
          />
        </div>
      </Reveal>

      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {highlightedSolutions.map((item, index) => (
          <Reveal key={item.slug} delay={(index % 3) * 90}>
            <Link
              href={`/solutions/${item.slug}`}
              className="group flex h-full min-h-[15rem] flex-col rounded-2xl p-7 transition-transform duration-300 hover:-translate-y-1"
              style={{ backgroundColor: c.card, boxShadow: cardShadowSmall }}
            >
              <p className="mb-4 text-[0.8125rem] font-medium" style={{ color: c.subtle, fontFamily: fonts.sans }}>
                {item.eyebrow}
              </p>
              <h3 className="mb-3 text-[1.0625rem] font-medium leading-[1.3]" style={{ color: c.deep, fontFamily: fonts.sans }}>
                {item.title}
              </h3>
              <p className="line-clamp-3 text-[0.9375rem] leading-[1.6]" style={{ color: c.mutedFg }}>
                {item.description}
              </p>
              <span className="mt-auto inline-flex items-center gap-1.5 pt-6 text-[0.9375rem] font-medium" style={{ color: c.forest }}>
                Read page
                <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          </Reveal>
        ))}
      </div>

      <div className="mt-7">
        <CtaButton href="/solutions" variant="outline">
          View all solution pages <ArrowRightIcon className="size-4" />
        </CtaButton>
      </div>
    </SectionShell>
  );
}
