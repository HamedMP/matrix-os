import { Check, ChevronRight, Minus } from "lucide-react";
import { PROJECT_SETUP_COMPACT_ANSWER_LENGTH, PROJECT_SETUP_PRIMARY_REPLY_LENGTH, type ProjectSetupDraft } from "@matrix-os/contracts";
import ReactMarkdown from "react-markdown";
import { ProjectSetupActionButton as Action, borderStyle } from "./ProjectSetupAction.js";
import { cn } from "../cn.js";

export const PROJECT_SETUP_COLUMN_CLASS = "mx-auto w-full max-w-[768px] px-4 @min-[768px]/bot-chat:px-6";

export const PROJECT_SETUP_COMPOSER_CLASS = `${PROJECT_SETUP_COLUMN_CLASS} shrink-0 pt-2 pb-3`;

type SetupStep = ProjectSetupDraft["step"];
type ProgressState = "current" | "incomplete" | "complete" | "skipped" | "described" | "pending";
const progressLabels = ["Guidance", "Skills", "MCP"] as const;
const progressStatusLabel = {
  complete: "ready",
  skipped: "skipped",
  described: "described",
  pending: "connection requested",
} as const;

function projectSetupProgress(draft: ProjectSetupDraft | null): ProgressState[] {
  if (!draft) return ["current", "incomplete", "incomplete"];
  const focus = draft.interview?.focus;
  const guidance = (focus === "intent" || focus === "guidance" || (!focus && draft.step === "guidance"))
    ? "current" : draft.answers.purpose && draft.answers.guidance ? "complete" : "incomplete";
  const legacyAfterSkills = !draft.interview && ["mcp", "review", "saved"].includes(draft.step);
  const skills = focus === "skill" || (!focus && ["skill", "skill_instructions"].includes(draft.step))
    ? "current" : draft.skill ? "complete" : draft.answers.skillInstructions ? "described"
      : (legacyAfterSkills || draft.interview?.skillSkipped) ? "skipped" : "incomplete";
  const mcp = focus === "mcp" || (!focus && draft.step === "mcp")
    ? "current" : draft.mcp.state === "not_requested" ? "incomplete" : draft.mcp.state;
  return [guidance, skills, mcp];
}

export function ProjectSetupProgress({ projectName, draft = null, onLeaveSetup }: {
  projectName: string;
  draft?: ProjectSetupDraft | null;
  onLeaveSetup?: () => void;
}) {
  return (
    <header className={cn(PROJECT_SETUP_COLUMN_CLASS, "min-w-0 shrink-0 space-y-3")} aria-label="Project setup">
      <div className="flex min-h-10 min-w-0 items-center justify-between gap-2 border-b pb-2" style={borderStyle}>
        <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <span className="truncate" title={projectName}>{projectName}</span>
          <ChevronRight aria-hidden size={12} className="shrink-0" />
          <span className="shrink-0">Project setup</span>
        </p>
        {draft?.step !== "saved" && onLeaveSetup ? (
          <div className="shrink-0 whitespace-nowrap"><Action onClick={onLeaveSetup}>Cancel setup</Action></div>
        ) : null}
      </div>
      <nav aria-label="Project setup progress">
        <ol className="grid w-full max-w-[434px] grid-cols-3 gap-1.5 text-xs">
          {projectSetupProgress(draft).map((state, index) => (
            <li
              key={progressLabels[index]}
              aria-current={state === "current" ? "step" : undefined}
              data-state={state}
              style={state === "current" ? {
                backgroundColor: "var(--success-muted, color-mix(in srgb, var(--success, var(--success-text, var(--foreground))) 13%, transparent))",
              } : undefined}
              className={cn("flex min-h-[28px] min-w-0 items-center gap-1.5 rounded-md px-2 py-1",
                state === "current"
                  ? "font-medium text-[var(--success-text,var(--foreground))]"
                  : "bg-[var(--bg-surface,var(--muted))] text-[var(--text-secondary,var(--muted-foreground))]")}
            >
              {state === "complete" ? <Check aria-hidden size={12} className="shrink-0 text-[var(--success-text,var(--success))]" />
                : state === "skipped" ? <Minus aria-hidden size={12} className="shrink-0" />
                  : <span className="shrink-0 tabular-nums" aria-hidden>{index + 1}</span>}
              <span>{progressLabels[index]}</span>
              {state !== "current" && state !== "incomplete" ? <span className="sr-only">{progressStatusLabel[state]}</span> : null}
            </li>
          ))}
        </ol>
      </nav>
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
  if (agentLed || introduction) return step === "review" ? "Tell me what to change…" : "Write your own answer…";
  if (mcpHandoff) return "Continue in MCP Settings or review below…";
  switch (step) {
    case "guidance": return "Describe how you want the AI to work…";
    case "skill":
    case "skill_instructions": return "Describe a task you want to repeat…";
    case "mcp": return "Tell me which service you use…";
    case "review": return "Tell Matrix what to change…";
    default: return undefined;
  }
}

const setupSentences = new Intl.Segmenter(undefined, { granularity: "sentence" });
const plainReply = /^[^\r\n<>`#*_\[\]]+$/u;

export function projectSetupReplyContent(replyText: string, review: boolean) {
  const text = replyText.trim();
  const firstParagraph = text.split(/\r?\n\s*\r?\n/u, 1)[0] ?? "";
  const fits = ({ segment }: Intl.SegmentData) => {
    const candidate = segment.trim();
    return candidate.length > 0 && candidate.length <= PROJECT_SETUP_PRIMARY_REPLY_LENGTH && plainReply.test(candidate);
  };
  const first = [...setupSentences.segment(firstParagraph)].find(fits);
  const isQuestion = ({ segment }: Intl.SegmentData) => /[?？]$/u.test(segment.trim());
  // Prefer the intended next action in Review and a primary question already
  // supplied in the opening paragraph. Older replies often introduce it later.
  const needsQuestion = !review && !(first && isQuestion(first));
  const questions = needsQuestion ? [...setupSentences.segment(text)].filter(isQuestion) : [];
  const main = questions.length > 0 ? questions.find(fits) : first;
  if (!main) return { prompt: undefined, detail: text };
  const detail = [text.slice(0, main.index).trim(), text.slice(main.index + main.segment.length).trim()]
    .filter(Boolean).join("\n\n");
  return { prompt: main.segment.trim(), detail };
}

export function isCompactSetupAnswer(text: string): boolean {
  return !/[\r\n]/u.test(text)
    && text.replace(/[^\p{ASCII}]/gu, "xx").length <= PROJECT_SETUP_COMPACT_ANSWER_LENGTH;
}

export const disclosureStyle = "w-fit cursor-pointer text-xs font-medium text-[var(--text-secondary,var(--muted-foreground))] hover:underline";

export function ProjectSetupReplyContext({ detail, review }: { detail: string; review: boolean }) {
  const markdown = (
    <div className="space-y-2 break-words leading-relaxed">
      <ReactMarkdown skipHtml components={{ img: () => null }}>{detail}</ReactMarkdown>
    </div>
  );
  if (review) return markdown;
  return (
    <details className="min-w-0 space-y-2">
      <summary className={disclosureStyle}>Read the agent’s question</summary>
      {markdown}
    </details>
  );
}
