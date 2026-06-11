import { ArrowRightIcon, BriefcaseBusinessIcon, CheckCircle2Icon, CloudIcon } from "lucide-react";
import { palette as c, cardShadow, cardShadowSmall, fonts } from "./theme";
import { CtaButton, SectionShell, SectionTitle } from "./primitives";
import { Reveal } from "./Reveal";

const hostedMatrixPoints = [
  "Choose region and power during signup",
  "Managed runtime, updates, shell, CLI, and previews",
  "Hermes and coding agents keep running while devices sleep",
  "Best path for teams, pilots, professionals, and universities",
] as const;

const guidedPilotPoints = [
  "Dedicated pilot path for teams, enterprise labs, and universities",
  "Isolated cloud computers for AI coding experiments",
  "Developer onboarding through CLI, docs, and Matrix skills",
  "Clear rollout plan for tools, regions, billing, and approvals",
] as const;

export function DeploymentSection() {
  return (
    <SectionShell id="deployment" className="pt-16 md:pt-28">
      <Reveal>
        <div className="mb-8 max-w-[44rem] md:mb-10">
          <SectionTitle
            title="Start with a private cloud computer."
            continuation="Hosted today, with guided pilots for organizations."
          />
        </div>
      </Reveal>

      <div className="grid gap-5 md:grid-cols-2">
        <Reveal>
          <article className="flex h-full flex-col rounded-2xl p-7 md:p-9" style={{ backgroundColor: c.card, boxShadow: cardShadow }}>
            <div className="mb-6 flex items-center gap-4">
              <span className="grid size-11 place-items-center rounded-lg" style={{ backgroundColor: "rgba(67,78,63,0.07)", color: c.forest }}>
                <CloudIcon className="size-5" />
              </span>
              <div>
                <p className="text-[0.8125rem] font-medium" style={{ color: c.subtle }}>Recommended</p>
                <h3 className="text-[1.1875rem] font-medium" style={{ color: c.deep, fontFamily: fonts.sans }}>Hosted Matrix</h3>
              </div>
            </div>
            <ul className="grid gap-3">
              {hostedMatrixPoints.map((point) => (
                <li key={point} className="flex gap-3 text-[0.9375rem] leading-[1.6]" style={{ color: c.mutedFg }}>
                  <CheckCircle2Icon className="mt-1 size-4 shrink-0" style={{ color: c.forest }} />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
            <div className="mt-auto pt-8">
              <CtaButton href="https://app.matrix-os.com" phLocation="deployment" phTarget="start_hosted">
                Start hosted <ArrowRightIcon className="size-4" />
              </CtaButton>
            </div>
          </article>
        </Reveal>

        <Reveal delay={90}>
          <article className="flex h-full flex-col rounded-2xl p-7 md:p-9" style={{ backgroundColor: c.card, boxShadow: cardShadowSmall }}>
            <div className="mb-6 flex items-center gap-4">
              <span className="grid size-11 place-items-center rounded-lg" style={{ backgroundColor: "rgba(67,78,63,0.07)", color: c.forest }}>
                <BriefcaseBusinessIcon className="size-5" />
              </span>
              <div>
                <p className="text-[0.8125rem] font-medium" style={{ color: c.subtle }}>For organizations</p>
                <h3 className="text-[1.1875rem] font-medium" style={{ color: c.deep, fontFamily: fonts.sans }}>Guided pilot</h3>
              </div>
            </div>
            <ul className="grid gap-3">
              {guidedPilotPoints.map((point) => (
                <li key={point} className="flex gap-3 text-[0.9375rem] leading-[1.6]" style={{ color: c.mutedFg }}>
                  <CheckCircle2Icon className="mt-1 size-4 shrink-0" style={{ color: c.forest }} />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
            <div className="mt-auto pt-8">
              <CtaButton href="/contact?audience=enterprise" variant="outline">
                Plan a pilot <ArrowRightIcon className="size-4" />
              </CtaButton>
            </div>
          </article>
        </Reveal>
      </div>
    </SectionShell>
  );
}
