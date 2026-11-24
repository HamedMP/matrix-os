import { Check, ChevronRight } from "lucide-react";
import type { ProjectSetupDraft } from "@matrix-os/contracts";

type SetupStep = ProjectSetupDraft["step"];
type ProgressState = "current" | "incomplete" | "complete" | "skipped" | "described";
const progressLabels = ["Guidance", "Skills", "MCP"] as const;

function projectSetupProgress(draft: ProjectSetupDraft | null): ProgressState[] {
  if (!draft || draft.step === "guidance") return ["current", "incomplete", "incomplete"];
  const skills = draft.skill ? "complete" : draft.answers.skillInstructions ? "described" : "skipped";
  if (draft.step === "skill" || draft.step === "skill_instructions") return ["complete", "current", "incomplete"];
  if (draft.step === "mcp") return ["complete", skills, "current"];
  return ["complete", skills, draft.mcp.state === "skipped" ? "skipped" : "current"];
}

export function ProjectSetupProgress({ projectName, draft = null, agentLed = Boolean(draft?.interview) }: {
  projectName: string;
  draft?: ProjectSetupDraft | null;
  agentLed?: boolean;
}) {
  return (
    <header className="min-w-0 space-y-4">
      <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
        <span className="truncate">{projectName}</span>
        <ChevronRight aria-hidden size={12} className="shrink-0" />
        <span className="shrink-0">Project setup</span>
      </p>
      {!agentLed ? <nav aria-label="Project setup progress">
        <ol className="grid w-full max-w-[434px] grid-cols-3 gap-2 text-xs">
          {projectSetupProgress(draft).map((state, index) => (
            <li
              key={progressLabels[index]}
              aria-current={state === "current" ? "step" : undefined}
              data-state={state}
              className={`flex min-h-[30px] min-w-0 flex-wrap items-center gap-1.5 rounded-md px-2 py-1.5 ${state === "current" ? "bg-[var(--success-muted,var(--bg-selected))] font-medium text-[var(--success-text,var(--foreground))]" : "bg-[var(--bg-surface,var(--muted))] text-[var(--text-secondary,var(--muted-foreground))]"}`}
            >
              {state === "complete" ? <Check aria-hidden size={12} className="text-[var(--success-text,var(--success))]" /> : state === "current" || state === "incomplete" ? <span aria-hidden>{index + 1}</span> : null}
              <span>{progressLabels[index]}</span>
              {state === "complete" ? <span className="sr-only">complete</span> : null}
              {state === "skipped" ? <span>skipped</span> : null}
              {state === "described" ? <span>to draft</span> : null}
            </li>
          ))}
        </ol>
      </nav> : null}
    </header>
  );
}

export function ProjectSetupAcceptedNote({ draft }: { draft: ProjectSetupDraft }) {
  if (draft.interview) return null;
  const note = draft.step === "skill" ? "Working preferences added"
    : draft.step === "mcp" && draft.skill ? `Project skill staged · ${draft.skill.name}`
    : draft.step === "mcp" && draft.answers.skillInstructions ? "Skill description added"
    : draft.step === "mcp" ? "Project skill skipped"
    : null;
  return note ? (
    <p className="mb-2.5 rounded-md bg-[var(--success-muted,var(--muted))] px-3 py-2 text-xs text-[var(--success-text,var(--foreground))]" role="status">
      {note}
    </p>
  ) : null;
}

export function projectSetupAnswerPlaceholder(
  introduction: boolean,
  step?: SetupStep,
  mcpHandoff = false,
  agentLed = false,
): string | undefined {
  if (step === "saved") return undefined;
  if (agentLed) return step === "review" ? "Tell me what to change…" : "Reply to the agent…";
  if (mcpHandoff) return "Continue in MCP Settings or review below…";
  if (introduction) return "Waiting for the first reply…";
  switch (step) {
    case "guidance": return "Describe how you want the AI to work…";
    case "skill":
    case "skill_instructions": return "Describe a task you want to repeat…";
    case "mcp": return "Tell me which service you use…";
    case "review": return "Tell Matrix what to change…";
    default: return undefined;
  }
}
