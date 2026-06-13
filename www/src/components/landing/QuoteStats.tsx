import { palette as c, cardShadowSmall, fonts } from "./theme";
import { SectionShell } from "./primitives";
import { Reveal } from "./Reveal";

const stats = [
  { value: "6+", label: "coding agents run side by side" },
  { value: "24/7", label: "sessions that outlive your laptop" },
  { value: "1", label: "private computer that is yours alone" },
] as const;

export function QuoteStats() {
  return (
    <SectionShell className="pt-16 md:pt-28">
      <Reveal>
        <div
          className="flex flex-col items-center rounded-2xl px-7 py-16 text-center md:py-24"
          style={{ backgroundColor: c.forestDeep, color: "#F4F2E6" }}
        >
          <p className="mb-8 text-[0.875rem]" style={{ fontFamily: fonts.display, color: "rgba(244,242,230,0.65)" }}>
            Why Matrix exists
          </p>
          <blockquote
            className="max-w-[44rem] text-[1.75rem] leading-[1.25] md:text-[2.75rem]"
            style={{ fontFamily: fonts.display, fontWeight: 400 }}
          >
            &ldquo;Local development was never built for autonomous agents. The work should live in a
            computer that never sleeps.&rdquo;
          </blockquote>
        </div>
      </Reveal>

      <div className="mt-5 grid gap-5 md:grid-cols-3">
        {stats.map((stat, index) => (
          <Reveal key={stat.value} delay={index * 90}>
            <div
              className="rounded-2xl px-8 py-9"
              style={{ backgroundColor: c.card, boxShadow: cardShadowSmall }}
            >
              <p
                className="text-[3rem] leading-none md:text-[3.5rem]"
                style={{ fontFamily: fonts.display, color: c.forest }}
              >
                {stat.value}
              </p>
              <p className="mt-3 text-[0.9375rem]" style={{ color: c.mutedFg, fontFamily: fonts.sans }}>
                {stat.label}
              </p>
            </div>
          </Reveal>
        ))}
      </div>
    </SectionShell>
  );
}
