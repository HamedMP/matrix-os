import { palette as c, fonts } from "./theme";
import { SectionCard, SectionShell, SectionTitle } from "./primitives";
import { Reveal } from "./Reveal";

const steps = [
  { step: "01", title: "Provision your Matrix computer", desc: "Choose power and region, start the hosted trial, and get a private cloud workstation for development." },
  { step: "02", title: "Connect tools and repos", desc: "Open the shell, run GitHub auth, clone the repo, and attach from the web UI or Matrix CLI." },
  { step: "03", title: "Run agents and workflows", desc: "Launch Claude, Codex, Cursor, OpenCode, Pi, Gemini CLI, or Hermes in persistent sessions." },
] as const;

export function HowItWorksSection() {
  return (
    <SectionShell className="pt-16 md:pt-28">
      <Reveal>
        <SectionCard>
          <div className="px-7 pt-9 pb-8 md:px-12 md:pt-12 md:pb-10" style={{ borderBottom: `1px solid ${c.border}` }}>
            <SectionTitle title="From signup to autonomous cloud dev." continuation="Three steps." />
          </div>
          <div className="grid md:grid-cols-3">
            {steps.map((item, index) => (
              <div
                key={item.step}
                className={`px-7 py-9 md:px-10 md:py-12 ${index < 2 ? "border-b md:border-b-0 md:border-r" : ""}`}
                style={{ borderColor: c.border }}
              >
                <span
                  className="block text-[2.75rem] leading-none md:text-[3.25rem]"
                  style={{ fontFamily: fonts.display, color: c.forest }}
                >
                  {item.step}
                </span>
                <h3 className="mt-5 text-[1.0625rem] font-medium" style={{ color: c.deep, fontFamily: fonts.sans }}>
                  {item.title}
                </h3>
                <p className="mt-2.5 text-[0.9375rem] leading-[1.65]" style={{ color: c.mutedFg }}>
                  {item.desc}
                </p>
              </div>
            ))}
          </div>
        </SectionCard>
      </Reveal>
    </SectionShell>
  );
}
