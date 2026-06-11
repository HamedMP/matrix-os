import { faqItems } from "./content";
import { palette as c, fonts } from "./theme";
import { SectionCard, SectionShell, SectionTitle } from "./primitives";
import { Reveal } from "./Reveal";

export function FaqSection() {
  return (
    <SectionShell className="pt-16 md:pt-28">
      <Reveal>
        <SectionCard>
          <div className="px-7 pt-9 pb-8 md:px-12 md:pt-12 md:pb-10" style={{ borderBottom: `1px solid ${c.border}` }}>
            <SectionTitle title="Questions, answered." />
          </div>
          <div className="grid md:grid-cols-2">
            {faqItems.map((item, index) => {
              const isLastRow = index >= faqItems.length - 2;
              const isLeftColumn = index % 2 === 0;
              return (
                <div
                  key={item.q}
                  className={`px-7 py-8 md:px-12 md:py-9 ${index < faqItems.length - 1 ? "border-b" : ""} ${isLastRow ? "md:border-b-0" : "md:border-b"} ${isLeftColumn ? "md:border-r" : ""}`}
                  style={{ borderColor: c.border }}
                >
                  <h3 className="text-[1rem] font-medium" style={{ color: c.deep, fontFamily: fonts.sans }}>
                    {item.q}
                  </h3>
                  <p className="mt-2.5 text-[0.9375rem] leading-[1.65]" style={{ color: c.mutedFg }}>
                    {item.a}
                  </p>
                </div>
              );
            })}
          </div>
        </SectionCard>
      </Reveal>
    </SectionShell>
  );
}
