import {
  ONBOARDING_FREEFORM_MAX_CHARS,
  onboardingResultTitle,
  onboardingTask,
  parseOnboardingRepoUrl,
  type OnboardingRequiredService,
  type OnboardingStarterTaskId,
  type OnboardingTaskId,
} from "#onboarding-widget-catalog";

export type OnboardingWidgetSize = "bubble" | "corner";
export type OnboardingAiProvider = "claude" | "codex";
export type OnboardingAiChoice = "matrix" | OnboardingAiProvider;

const AI_LABELS: Record<OnboardingAiChoice, string> = { matrix: "Matrix AI", claude: "Claude", codex: "ChatGPT" };

export function onboardingAiLabel(choice: OnboardingAiChoice): string {
  return AI_LABELS[choice];
}
export type OnboardingRunPhase = "waiting_computer" | "starting" | "running" | "done" | "failed";

export interface OnboardingRunScreen {
  kind: "run";
  taskId: OnboardingTaskId;
  answer: string;
  appConnected: boolean;
  simpler: boolean;
  context?: string;
  /** Follow-ups keep the title of the result they continue. */
  title?: string;
  phase: OnboardingRunPhase;
  requestId: number;
  runId?: string;
}

export type OnboardingScreen =
  | { kind: "tasks" }
  | { kind: "apps" }
  | { kind: "question"; taskId: OnboardingStarterTaskId }
  | { kind: "connect"; taskId: OnboardingStarterTaskId; status: "idle" | "connecting" | "failed" }
  | { kind: "repo" }
  | OnboardingRunScreen;

export type OnboardingAiPanel =
  | { step: "menu" }
  | { step: "method"; provider: OnboardingAiProvider }
  | { step: "waiting"; provider: OnboardingAiProvider; status: "waiting" | "failed" }
  | { step: "key"; provider: OnboardingAiProvider; status: "idle" | "saving" | "failed" };

export interface OnboardingWidgetState {
  screen: OnboardingScreen;
  ai: OnboardingAiPanel | null;
  aiChoice: OnboardingAiChoice;
  echo: string | null;
  notice: string | null;
  size: OnboardingWidgetSize;
  unread: number;
  chatId: string | null;
  started: boolean;
  followUpUsed: boolean;
  firstTaskCompleted: boolean;
  nextRequestId: number;
}

export type OnboardingWidgetEvent =
  | { type: "task.selected"; taskId: OnboardingStarterTaskId; connectedServices: readonly OnboardingRequiredService[] }
  | { type: "answer.submitted"; text: string; context?: string }
  | { type: "freeform.submitted"; text: string }
  | { type: "connect.started" }
  | { type: "connect.succeeded" }
  | { type: "connect.failed" }
  | { type: "connect.skipped" }
  | { type: "apps.opened" }
  | { type: "apps.closed"; connectedNames: readonly string[] }
  | { type: "tasks.requested" }
  | { type: "computer.waiting" }
  | { type: "computer.ready" }
  | { type: "run.admitted"; requestId: number; chatId: string; runId: string }
  | { type: "run.failedToStart" }
  | { type: "run.settled"; runId: string; outcome: "completed" | "failed" }
  | { type: "run.retried"; simpler: boolean }
  | { type: "followUp.chosen"; choice: string; prompt: string | null }
  | { type: "followUp.dismissed" }
  | { type: "ai.menuToggled" }
  | { type: "ai.providerPicked"; provider: OnboardingAiProvider }
  | { type: "ai.methodPicked"; method: "account" | "api_key" }
  | { type: "ai.keySubmitted" }
  | { type: "ai.failed" }
  | { type: "ai.retried" }
  | { type: "ai.connected"; provider: OnboardingAiProvider }
  | { type: "ai.selected"; provider: OnboardingAiChoice }
  | { type: "ai.cancelled" }
  | { type: "ai.keepMatrix" }
  | { type: "size.changed"; size: OnboardingWidgetSize };

export interface OnboardingWidgetInit {
  size: OnboardingWidgetSize;
  firstTaskCompleted: boolean;
  aiChoice?: OnboardingAiChoice;
  chatId?: string | null;
}

export function initialOnboardingWidgetState(init: OnboardingWidgetInit): OnboardingWidgetState {
  return {
    screen: { kind: "tasks" },
    ai: null,
    aiChoice: init.aiChoice ?? "matrix",
    echo: null,
    notice: null,
    size: init.size,
    unread: 0,
    chatId: init.chatId ?? null,
    started: false,
    followUpUsed: false,
    firstTaskCompleted: init.firstTaskCompleted,
    nextRequestId: 1,
  };
}

function boundedText(text: string): string {
  return text.trim().slice(0, ONBOARDING_FREEFORM_MAX_CHARS);
}

function startRun(
  state: OnboardingWidgetState,
  run: Pick<OnboardingRunScreen, "taskId" | "answer" | "appConnected" | "simpler" | "context" | "title">,
  patch: Partial<OnboardingWidgetState> = {},
): OnboardingWidgetState {
  return {
    ...state,
    ...patch,
    ai: null,
    started: true,
    followUpUsed: patch.followUpUsed ?? false,
    nextRequestId: state.nextRequestId + 1,
    screen: { kind: "run", ...run, phase: "starting", requestId: state.nextRequestId },
  };
}

function afterConnect(state: OnboardingWidgetState, taskId: OnboardingStarterTaskId, connected: boolean): OnboardingWidgetState {
  const task = onboardingTask(taskId);
  const notice = connected && task?.needs ? `${task.needs.name} connected` : state.notice;
  if (taskId === "work-on-code") return { ...state, notice, screen: { kind: "repo" } };
  if (task?.question) return { ...state, notice, screen: { kind: "question", taskId } };
  return startRun(state, { taskId, answer: "", appConnected: connected, simpler: false }, { notice });
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function onboardingRunTitle(run: Pick<OnboardingRunScreen, "taskId" | "answer" | "title">): string {
  return run.title ?? onboardingResultTitle(run.taskId, run.answer);
}

function withRun(state: OnboardingWidgetState, patch: Partial<OnboardingRunScreen>): OnboardingWidgetState {
  if (state.screen.kind !== "run") return state;
  return { ...state, screen: { ...state.screen, ...patch } };
}

export function reduceOnboardingWidget(state: OnboardingWidgetState, event: OnboardingWidgetEvent): OnboardingWidgetState {
  const screen = state.screen;
  switch (event.type) {
    case "task.selected": {
      const task = onboardingTask(event.taskId);
      if (!task) return state;
      const base = { ...state, ai: null, echo: task.label, notice: null };
      if (task.needs && !event.connectedServices.includes(task.needs.service)) {
        return { ...base, screen: { kind: "connect", taskId: task.id, status: "idle" } };
      }
      return afterConnect(base, task.id, Boolean(task.needs));
    }
    case "answer.submitted": {
      const answer = boundedText(event.text);
      if (!answer) return state;
      if (screen.kind === "question") {
        return startRun(state, { taskId: screen.taskId, answer, appConnected: true, simpler: false }, { echo: answer });
      }
      if (screen.kind === "repo") {
        const repo = event.context ? parseOnboardingRepoUrl(event.context) : null;
        return startRun(state, { taskId: "work-on-code", answer, appConnected: true, simpler: false, ...(repo ? { context: repo.url } : {}) }, { echo: answer });
      }
      return reduceOnboardingWidget(state, { type: "freeform.submitted", text: answer });
    }
    case "freeform.submitted": {
      const answer = boundedText(event.text);
      if (!answer) return state;
      return startRun(state, { taskId: "custom", answer, appConnected: false, simpler: false }, { echo: answer, notice: null });
    }
    case "connect.started":
      return screen.kind === "connect" ? { ...state, screen: { ...screen, status: "connecting" } } : state;
    case "connect.failed":
      return screen.kind === "connect" ? { ...state, screen: { ...screen, status: "failed" } } : state;
    case "connect.succeeded":
      return screen.kind === "connect" ? afterConnect(state, screen.taskId, true) : state;
    case "connect.skipped":
      return screen.kind === "connect" ? afterConnect({ ...state, echo: "Skip" }, screen.taskId, false) : state;
    case "apps.opened":
      return { ...state, ai: null, echo: "Connect apps first", notice: null, screen: { kind: "apps" } };
    case "apps.closed":
      return {
        ...state,
        echo: "Done",
        notice: event.connectedNames.length > 0 ? `${joinNames(event.connectedNames)} connected` : null,
        screen: { kind: "tasks" },
      };
    case "tasks.requested":
      return { ...state, ai: null, echo: null, notice: null, screen: { kind: "tasks" } };
    case "computer.waiting":
      return screen.kind === "run" && screen.phase === "starting" ? withRun(state, { phase: "waiting_computer" }) : state;
    case "computer.ready":
      if (screen.kind !== "run" || screen.phase !== "waiting_computer") return state;
      return {
        ...state,
        nextRequestId: state.nextRequestId + 1,
        screen: { ...screen, phase: "starting", requestId: state.nextRequestId },
      };
    case "run.admitted":
      if (screen.kind !== "run" || screen.requestId !== event.requestId || screen.phase !== "starting") return state;
      return { ...state, chatId: event.chatId, screen: { ...screen, phase: "running", runId: event.runId } };
    case "run.failedToStart":
      return screen.kind === "run" && screen.phase === "starting" ? withRun(state, { phase: "failed" }) : state;
    case "run.settled": {
      if (screen.kind !== "run" || screen.runId !== event.runId || screen.phase !== "running") return state;
      const done = event.outcome === "completed";
      return {
        ...state,
        firstTaskCompleted: state.firstTaskCompleted || done,
        unread: state.size === "bubble" ? state.unread + 1 : state.unread,
        screen: { ...screen, phase: done ? "done" : "failed" },
      };
    }
    case "run.retried":
      if (screen.kind !== "run" || screen.phase !== "failed") return state;
      return startRun(state, { taskId: screen.taskId, answer: screen.answer, appConnected: screen.appConnected, simpler: event.simpler, ...(screen.context ? { context: screen.context } : {}), ...(screen.title ? { title: screen.title } : {}) });
    case "followUp.chosen": {
      const prompt = event.prompt ? boundedText(event.prompt) : "";
      if (!prompt) return { ...state, followUpUsed: true };
      const title = screen.kind === "run" ? onboardingRunTitle(screen) : undefined;
      return startRun(state, { taskId: "custom", answer: prompt, appConnected: false, simpler: false, ...(title ? { title } : {}) }, { echo: event.choice, notice: null, followUpUsed: true });
    }
    case "followUp.dismissed":
      return { ...state, followUpUsed: true };
    case "ai.menuToggled":
      return { ...state, ai: state.ai ? null : { step: "menu" } };
    case "ai.providerPicked":
      return { ...state, ai: { step: "method", provider: event.provider } };
    case "ai.methodPicked":
      if (state.ai?.step !== "method") return state;
      return {
        ...state,
        ai: event.method === "account"
          ? { step: "waiting", provider: state.ai.provider, status: "waiting" }
          : { step: "key", provider: state.ai.provider, status: "idle" },
      };
    case "ai.keySubmitted":
      return state.ai?.step === "key" ? { ...state, ai: { ...state.ai, status: "saving" } } : state;
    case "ai.failed":
      if (state.ai?.step === "waiting" || state.ai?.step === "key") {
        return { ...state, ai: { ...state.ai, status: "failed" } };
      }
      return state;
    case "ai.retried":
      if (state.ai?.step === "waiting") return { ...state, ai: { ...state.ai, status: "waiting" } };
      if (state.ai?.step === "key") return { ...state, ai: { ...state.ai, status: "idle" } };
      return state;
    case "ai.connected":
      return { ...state, ai: null, aiChoice: event.provider, echo: null, notice: `${onboardingAiLabel(event.provider)} connected`, screen: { kind: "tasks" } };
    case "ai.selected":
      return { ...state, ai: null, aiChoice: event.provider };
    case "ai.cancelled":
    case "ai.keepMatrix":
      return { ...state, ai: null };
    case "size.changed":
      return { ...state, size: event.size, ai: null, unread: event.size === "bubble" ? state.unread : 0 };
  }
}
