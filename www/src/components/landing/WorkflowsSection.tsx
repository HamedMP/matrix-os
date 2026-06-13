import Link from "next/link";
import { ArrowRightIcon, CalendarIcon, FileTextIcon, MailIcon, SearchIcon } from "lucide-react";
import { palette as c, cardShadowSmall, fonts } from "./theme";
import { SectionShell, SectionTitle } from "./primitives";
import { Reveal } from "./Reveal";

const professionalWorkflows = [
  {
    Icon: MailIcon,
    title: "Inbox and follow-ups",
    desc: "Hermes can summarize unread mail, draft replies, flag urgent threads, and remind you who needs an answer.",
    example: "Draft replies for my important emails and list the ones I should approve.",
  },
  {
    Icon: CalendarIcon,
    title: "Meeting prep",
    desc: "Pull notes, calendar context, CRM details, documents, and prior decisions into one brief before the call.",
    example: "Prepare me for tomorrow's investor meeting with open questions and next steps.",
  },
  {
    Icon: SearchIcon,
    title: "Research reports",
    desc: "Run browser-backed research, compare sources, collect links, and produce a clean report in your workspace.",
    example: "Research three competitors and summarize pricing, positioning, and product gaps.",
  },
  {
    Icon: FileTextIcon,
    title: "Docs and dashboards",
    desc: "Turn recurring work into reports, trackers, summaries, and internal tools that stay connected to the same context.",
    example: "Create a weekly operating dashboard from GitHub, Linear, Slack, and calendar activity.",
  },
] as const;

export function WorkflowsSection() {
  return (
    <SectionShell id="professional-workflows" className="pt-16 md:pt-28">
      <Reveal>
        <div className="mb-8 max-w-[44rem] md:mb-10">
          <SectionTitle
            title="An assistant that does the work."
            continuation="Hermes gets a persistent computer for recurring professional workflows."
          />
        </div>
      </Reveal>

      <div className="grid gap-5 md:grid-cols-2">
        {professionalWorkflows.map((item, index) => (
          <Reveal key={item.title} delay={(index % 2) * 90}>
            <article
              className="flex h-full flex-col rounded-2xl p-7 md:p-8"
              style={{ backgroundColor: c.card, boxShadow: cardShadowSmall }}
            >
              <div className="flex items-start gap-4">
                <span
                  className="grid size-10 shrink-0 place-items-center rounded-lg"
                  style={{ backgroundColor: "rgba(67,78,63,0.07)", color: c.forest }}
                >
                  <item.Icon className="size-4" />
                </span>
                <div>
                  <h3 className="text-[1.0625rem] font-medium" style={{ color: c.deep, fontFamily: fonts.sans }}>
                    {item.title}
                  </h3>
                  <p className="mt-2 text-[0.9375rem] leading-[1.6]" style={{ color: c.mutedFg }}>
                    {item.desc}
                  </p>
                </div>
              </div>
              <p
                className="mt-6 border-l-2 pl-4 text-[1.0625rem] italic leading-[1.5]"
                style={{ color: c.forest, borderColor: c.border, fontFamily: fonts.display }}
              >
                &ldquo;{item.example}&rdquo;
              </p>
            </article>
          </Reveal>
        ))}
      </div>

      <Reveal>
        <div
          className="mt-5 flex flex-col gap-4 rounded-2xl px-7 py-6 sm:flex-row sm:items-center sm:justify-between"
          style={{ backgroundColor: c.forestDeep, color: "#F4F2E6" }}
        >
          <p className="max-w-2xl text-[0.9375rem] leading-[1.6]" style={{ color: "rgba(244,242,230,0.78)", fontFamily: fonts.sans }}>
            Want Hermes hosted for a professional workflow, not a coding workflow?
          </p>
          <Link
            href="/contact?audience=hermes-hosting"
            className="inline-flex shrink-0 items-center gap-2 rounded-[0.625rem] px-4 py-3 text-[0.9375rem] font-medium leading-none transition-opacity hover:opacity-85"
            style={{ backgroundColor: "#F4F2E6", color: c.forestDeep }}
          >
            Talk to Matrix <ArrowRightIcon className="size-4" />
          </Link>
        </div>
      </Reveal>
    </SectionShell>
  );
}
