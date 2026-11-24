import { Check, ChevronRight } from "lucide-react";
import { PROJECT_SETUP_COMPACT_ANSWER_LENGTH, PROJECT_SETUP_PRIMARY_REPLY_LENGTH, type ProjectSetupDraft } from "@matrix-os/contracts";
import ReactMarkdown from "react-markdown";
import { ProjectSetupActionButton as Action, borderStyle } from "./ProjectSetupAction.js";
import { cn } from "../cn.js";

export const PROJECT_SETUP_COLUMN_CLASS = "mx-auto w-full max-w-[768px] px-4 @min-[768px]/bot-chat:px-6";

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

export function ProjectSetupProgress({ projectName, draft = null, agentLed = Boolean(draft?.interview), onLeaveSetup }: {
  projectName: string;
  draft?: ProjectSetupDraft | null;
  agentLed?: boolean;
  onLeaveSetup?: () => void;
}) {
  return (
    <header className={cn("min-w-0 space-y-3", draft && PROJECT_SETUP_COLUMN_CLASS, draft && "shrink-0")} aria-label="Project setup">
      <div className={cn("flex min-w-0 items-center justify-between gap-2", draft && "min-h-10 border-b pb-2")} style={draft ? borderStyle : undefined}>
        <p className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          <span className="truncate" title={projectName}>{projectName}</span>
          <ChevronRight aria-hidden size={12} className="shrink-0" />
          <span className="shrink-0">Project setup</span>
        </p>
        {agentLed && draft && draft.step !== "saved" && onLeaveSetup ? (
          <div className="shrink-0 whitespace-nowrap"><Action onClick={onLeaveSetup}>Cancel setup</Action></div>
        ) : null}
      </div>
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
  if (agentLed) return step === "review" ? "Tell me what to change…" : "Write your own answer…";
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
