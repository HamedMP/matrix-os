import { onboardingTask, onboardingWorkingLine } from "#onboarding-widget-catalog";
import { onboardingRunTitle, type OnboardingWidgetState } from "#onboarding-widget";

export const ONBOARDING_WORK_LOG_MAX_STEPS = 6;
const RESULT_SUMMARY_MAX_CHARS = 160;

type RunSourcePart =
  | { type: "text"; text: string }
  | { type: "tool_request"; toolCallId: string; name: string; label: string }
  | { type: "tool_result"; toolCallId: string; outcome: "success" | "failed" | "cancelled"; truncated: boolean }
  | { type: string };

export interface OnboardingRunSource {
  runs: readonly { id: string; status: string }[];
  messages: readonly { runId?: string | null; role: string; parts: readonly RunSourcePart[] }[];
}

export type OnboardingRunStatus = "pending" | "running" | "waiting" | "completed" | "failed";

export interface OnboardingWorkStep {
  id: string;
  label: string;
  state: "running" | "done" | "failed";
}

export interface OnboardingRunView {
  status: OnboardingRunStatus;
  steps: OnboardingWorkStep[];
  resultText?: string;
  resultSummary?: string;
}

function runStatus(status: string): OnboardingRunStatus {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "aborted") return "failed";
  if (status.startsWith("waiting")) return "waiting";
  return "running";
}

function isPart<T extends RunSourcePart["type"]>(part: RunSourcePart, type: T): part is Extract<RunSourcePart, { type: T }> {
  return part.type === type;
}

export function deriveOnboardingRunView(
  source: OnboardingRunSource,
  runId: string,
  options: { failedStepLabel?: string } = {},
): OnboardingRunView {
  const run = source.runs.find((candidate) => candidate.id === runId);
  if (!run) return { status: "pending", steps: [] };
  const status = runStatus(run.status);
  const steps: OnboardingWorkStep[] = [];
  let resultText: string | undefined;
  for (const message of source.messages) {
    if (message.runId !== runId) continue;
    for (const part of message.parts) {
      if (isPart(part, "tool_request")) {
        steps.push({ id: part.toolCallId, label: part.label, state: "running" });
      } else if (isPart(part, "tool_result")) {
        const step = steps.find((candidate) => candidate.id === part.toolCallId);
        if (step) step.state = part.outcome === "success" ? "done" : "failed";
      } else if (isPart(part, "text") && message.role === "assistant" && part.text.trim()) {
        resultText = part.text.trim();
      }
    }
  }
  const settled = status === "completed" || status === "failed";
  let view: OnboardingWorkStep[] = steps.map(({ id, label, state }) => ({
    id,
    label,
    state: settled && state === "running" ? (status === "failed" ? "failed" : "done") : state,
  }));
  if (status === "failed" && !view.some((step) => step.state === "failed")) {
    view.push({ id: "run-failed", label: options.failedStepLabel ?? "Couldn't finish this", state: "failed" });
  }
  view = view.slice(-ONBOARDING_WORK_LOG_MAX_STEPS);
  if (status !== "completed" || !resultText) return { status, steps: view };
  const firstLine = resultText.split("\n").find((line) => line.trim())?.trim() ?? resultText;
  return {
    status,
    steps: view,
    resultText,
    resultSummary: plainSummaryLine(firstLine).slice(0, RESULT_SUMMARY_MAX_CHARS),
  };
}

function plainSummaryLine(line: string): string {
  return line
    .replace(/^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?![\w*])/g, "$1$2")
    .replace(/(^|\W)_(?!\s)([^_]+?)_(?!\w)/g, "$1$2")
    .trim();
}

export interface OnboardingBubbleView {
  tone: "idle" | "working" | "ready" | "attention";
  title: string;
  subtitle: string;
  count: number;
}

export function deriveOnboardingBubble(state: OnboardingWidgetState, runView: OnboardingRunView | null): OnboardingBubbleView {
  const screen = state.screen;
  if (screen.kind === "run") {
    const task = onboardingTask(screen.taskId);
    const title = onboardingRunTitle(screen);
    const workingLine = screen.title ?? onboardingWorkingLine(screen.taskId, screen.answer);
    if (screen.phase === "done") {
      if (state.unread === 0) {
        if (task && !state.followUpUsed) return { tone: "idle", title: IDLE_BUBBLE_TITLE, subtitle: `1 step left · ${task.nextStep}`, count: 1 };
        return { tone: "idle", title: IDLE_BUBBLE_TITLE, subtitle: title, count: 0 };
      }
      return { tone: "ready", title: task?.readyBubble ?? "Your result is ready", subtitle: title, count: state.unread };
    }
    if (screen.phase === "failed" || runView?.status === "failed") {
      return { tone: "attention", title: "I couldn't finish this one", subtitle: workingLine, count: state.unread };
    }
    if (screen.phase === "waiting_computer") {
      return { tone: "attention", title: "Starting your computer…", subtitle: workingLine, count: 0 };
    }
    return { tone: "working", title: "Working…", subtitle: workingLine, count: 0 };
  }
  return { tone: "idle", title: IDLE_BUBBLE_TITLE, subtitle: "What should I start on?", count: state.unread };
}

const IDLE_BUBBLE_TITLE = "Pick up where we left off";
