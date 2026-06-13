import Link from "next/link";
import { ArrowRightIcon, Layers3Icon, RocketIcon, WorkflowIcon } from "lucide-react";
import { palette as c, fonts } from "./theme";
import { SectionShell } from "./primitives";
import { Reveal } from "./Reveal";

const hermesCards = [
  { Icon: WorkflowIcon, title: "Run background jobs", desc: "Turn recurring product, support, finance, and engineering work into scheduled Matrix workflows with logs and approvals." },
  { Icon: Layers3Icon, title: "Connect the company brain", desc: "Work across GitHub, Linear, Slack, Gmail, Calendar, Drive, Sentry, Datadog, billing, and Matrix apps." },
  { Icon: RocketIcon, title: "Operate through UI, CLI, and RPC", desc: "Give teams a real control surface for agents, jobs, schedules, tool permissions, run history, and handoffs." },
] as const;

export function HermesSection({ exploreHref }: { exploreHref?: string }) {
  return (
    <SectionShell id="hermes" className="pt-16 md:pt-28">
      <Reveal>
        <div className="rounded-2xl px-7 py-10 md:px-12 md:py-14" style={{ backgroundColor: c.forestDeep, color: "#F4F2E6" }}>
          <div className="grid gap-10 md:grid-cols-[1fr_1.05fr] md:items-center">
            <div>
              <p className="mb-6 text-[0.875rem]" style={{ fontFamily: fonts.display, color: "rgba(244,242,230,0.6)" }}>
                Hermes
              </p>
              <h2
                className="max-w-[22rem] text-[2rem] leading-[1.1] md:text-[2.75rem]"
                style={{ fontFamily: fonts.display, fontWeight: 400 }}
              >
                The resident agent for company workflows
              </h2>
              <p className="mt-6 max-w-[26rem] text-[0.9375rem] leading-[1.7]" style={{ color: "rgba(244,242,230,0.72)", fontFamily: fonts.sans }}>
                Coding is the first wedge. Hermes is the broader operating layer: connected
                tools, scheduled workflows, notifications, approvals, memory, and everyday business actions.
              </p>
              {exploreHref ? (
                <Link
                  href={exploreHref}
                  className="group mt-6 inline-flex items-center gap-1.5 text-[0.9375rem] font-medium transition-opacity hover:opacity-75"
                  style={{ color: "#F4F2E6" }}
                >
                  Explore Hermes
                  <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              ) : null}
            </div>
            <div className="grid gap-3">
              {hermesCards.map((card) => (
                <article
                  key={card.title}
                  className="grid grid-cols-[2.5rem_1fr] items-start gap-4 rounded-xl p-5"
                  style={{ backgroundColor: "rgba(244,242,230,0.06)", border: "1px solid rgba(244,242,230,0.12)" }}
                >
                  <span
                    className="grid size-10 place-items-center rounded-lg"
                    style={{ backgroundColor: "rgba(244,242,230,0.1)", color: "#F4F2E6" }}
                  >
                    <card.Icon className="size-4" />
                  </span>
                  <div>
                    <h3 className="text-[1rem] font-medium" style={{ fontFamily: fonts.sans }}>{card.title}</h3>
                    <p className="mt-1 text-[0.875rem] leading-[1.6]" style={{ color: "rgba(244,242,230,0.65)" }}>
                      {card.desc}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </div>
      </Reveal>
    </SectionShell>
  );
}
