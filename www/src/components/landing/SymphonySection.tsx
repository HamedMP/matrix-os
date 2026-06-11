import { WorkflowIcon } from "lucide-react";
import { palette as c, fonts } from "./theme";
import { SectionCard, SectionShell, SectionTitle } from "./primitives";
import { Reveal } from "./Reveal";

const queueRows = [
  ["Codex", "Refactor billing checkout", "running tests", "+82 -19"],
  ["Claude Code", "Add CLI quickstart", "ready for review", "+54 -8"],
  ["Hermes", "Turn Discord feedback into Linear tasks", "waiting on approval", "+0 -0"],
] as const;

const symphonyPoints = [
  { title: "Run agents in parallel", desc: "Split work across Claude, Codex, Cursor, OpenCode, or Gemini CLI sessions without blocking your laptop." },
  { title: "See status at a glance", desc: "Track what each agent is reading, editing, testing, previewing, and waiting on before you review." },
  { title: "Merge what survives review", desc: "Keep human control over branches, diffs, checks, browser previews, and PRs." },
] as const;

export function SymphonySection() {
  return (
    <SectionShell id="symphony" className="pt-16 md:pt-28">
      <Reveal>
        <SectionCard>
          <div className="px-7 pt-9 pb-8 md:px-12 md:pt-12 md:pb-10" style={{ borderBottom: `1px solid ${c.border}` }}>
            <SectionTitle
              title="Symphony orchestrates the work."
              continuation="Assign tasks, run agents in parallel, review only what survives."
            />
          </div>

          <div className="grid md:grid-cols-[1fr_1.1fr]">
            <div className="flex flex-col gap-8 px-7 py-9 md:border-r md:px-12 md:py-12" style={{ borderColor: c.border }}>
              {symphonyPoints.map((point) => (
                <div key={point.title}>
                  <h3 className="text-[1.0625rem] font-medium" style={{ color: c.deep, fontFamily: fonts.sans }}>
                    {point.title}
                  </h3>
                  <p className="mt-2 max-w-[24rem] text-[0.9375rem] leading-[1.6]" style={{ color: c.mutedFg }}>
                    {point.desc}
                  </p>
                </div>
              ))}
            </div>

            <div className="px-7 py-9 md:px-12 md:py-12">
              <div className="mb-5 flex items-center justify-between">
                <div>
                  <p className="text-[0.8125rem] font-medium" style={{ color: c.subtle }}>Agent queue</p>
                  <p className="mt-1 text-[0.9375rem]" style={{ color: c.mutedFg }}>3 active sessions · 2 ready for review</p>
                </div>
                <WorkflowIcon className="size-5" style={{ color: c.forest }} />
              </div>
              <div className="overflow-hidden rounded-xl" style={{ border: `1px solid ${c.border}` }}>
                {queueRows.map(([agent, task, state, diff], index) => (
                  <div
                    key={task}
                    className={`grid grid-cols-[1fr_auto] items-start gap-3 px-5 py-4 ${index < queueRows.length - 1 ? "border-b" : ""}`}
                    style={{ borderColor: c.border, backgroundColor: index === 1 ? "rgba(67,78,63,0.04)" : undefined }}
                  >
                    <div>
                      <p className="text-[0.8125rem] font-semibold" style={{ color: c.forest }}>{agent}</p>
                      <p className="mt-0.5 text-[0.9375rem]" style={{ color: c.deep }}>{task}</p>
                      <p className="mt-1 text-[0.8125rem]" style={{ color: c.subtle }}>{state}</p>
                    </div>
                    <span
                      className="rounded-md px-2 py-1 text-[0.8125rem] font-medium"
                      style={{ color: c.forest, backgroundColor: "rgba(67,78,63,0.07)", fontFamily: "var(--font-jetbrains), monospace" }}
                    >
                      {diff}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </SectionCard>
      </Reveal>
    </SectionShell>
  );
}
