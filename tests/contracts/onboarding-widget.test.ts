import { describe, expect, it } from "vitest";
import {
  ONBOARDING_FREEFORM_MAX_CHARS,
  ONBOARDING_TASKS,
  buildOnboardingPrompt,
  deriveOnboardingBubble,
  deriveOnboardingRunView,
  initialOnboardingWidgetState,
  onboardingAiLabel,
  onboardingChatTitle,
  onboardingPendingRun,
  onboardingRunInFlight,
  onboardingRunTitle,
  parseOnboardingRepoUrl,
  reduceOnboardingWidget,
  type OnboardingRunSource,
  type OnboardingWidgetEvent,
  type OnboardingWidgetState,
} from "../../packages/contracts/src/index.js";

function run(state: OnboardingWidgetState, ...events: OnboardingWidgetEvent[]): OnboardingWidgetState {
  return events.reduce(reduceOnboardingWidget, state);
}

const fresh = () => initialOnboardingWidgetState({ size: "corner", firstTaskCompleted: false });

describe("onboarding task catalog", () => {
  it("lists the four starter tasks with the exact Figma copy and app tags", () => {
    expect(ONBOARDING_TASKS.map((task) => [task.label, task.needs?.tag ?? null])).toEqual([
      ["Research anything", null],
      ["Plan my week", "Needs Calendar"],
      ["Build a website", null],
      ["Work on my code", "Needs GitHub"],
    ]);
    const research = ONBOARDING_TASKS.find((task) => task.id === "research");
    expect(research?.question).toEqual({
      text: "Sure. What topic?",
      chips: ["AI agent pricing", "Best CRM for startups", "Trip ideas for Lisbon"],
      placeholder: "Type a topic…",
    });
    const website = ONBOARDING_TASKS.find((task) => task.id === "build-website");
    expect(website?.question?.chips).toEqual(["Portfolio", "Landing page", "Event page", "Blog"]);
  });

  it("never uses bot or library in user-facing copy", () => {
    const copy = JSON.stringify(ONBOARDING_TASKS);
    expect(copy).not.toMatch(/\bbot\b|\blibrary\b/i);
  });
});

describe("reduceOnboardingWidget", () => {
  it("starts on the task list with the greeting and Matrix AI", () => {
    const state = fresh();
    expect(state.screen).toEqual({ kind: "tasks" });
    expect(state.started).toBe(false);
    expect(state.aiChoice).toBe("matrix");
    expect(onboardingAiLabel(state.aiChoice)).toBe("Matrix AI");
  });

  it("asks one question for research and starts a run from a chip", () => {
    const asked = run(fresh(), { type: "task.selected", taskId: "research", connectedServices: [] });
    expect(asked.screen).toEqual({ kind: "question", taskId: "research" });
    expect(asked.echo).toBe("Research anything");
    const started = run(asked, { type: "answer.submitted", text: "AI agent pricing" });
    expect(started.screen).toMatchObject({ kind: "run", taskId: "research", answer: "AI agent pricing", phase: "starting", simpler: false });
    expect(started.echo).toBe("AI agent pricing");
    expect(started.started).toBe(true);
  });

  it("asks for only the app a task needs, and skipping still runs a smaller version", () => {
    const connect = run(fresh(), { type: "task.selected", taskId: "plan-week", connectedServices: [] });
    expect(connect.screen).toEqual({ kind: "connect", taskId: "plan-week", status: "idle" });
    const skipped = run(connect, { type: "connect.skipped" });
    expect(skipped.screen).toMatchObject({ kind: "run", taskId: "plan-week", appConnected: false });
  });

  it("goes straight to the work when the app is already connected", () => {
    const state = run(fresh(), { type: "task.selected", taskId: "plan-week", connectedServices: ["google_calendar"] });
    expect(state.screen).toMatchObject({ kind: "run", taskId: "plan-week", appConnected: true });
  });

  it("shows a red sign-in line on failure and recovers with retry or skip", () => {
    const failed = run(
      fresh(),
      { type: "task.selected", taskId: "plan-week", connectedServices: [] },
      { type: "connect.started" },
      { type: "connect.failed", service: "google_calendar" },
    );
    expect(failed.screen).toEqual({ kind: "connect", taskId: "plan-week", status: "failed" });
    const connected = run(failed, { type: "connect.started" }, { type: "connect.succeeded", service: "google_calendar" });
    expect(connected.notice).toBe("Google Calendar connected");
    expect(connected.screen).toMatchObject({ kind: "run", appConnected: true });
  });

  it("offers only Skip when the computer can't connect apps", () => {
    const unavailable = run(fresh(), { type: "task.selected", taskId: "work-on-code", connectedServices: [], appsUnavailable: true });
    expect(unavailable.screen).toEqual({ kind: "connect", taskId: "work-on-code", status: "unavailable" });
    expect(run(unavailable, { type: "connect.started" }).screen).toEqual(unavailable.screen);
    expect(run(unavailable, { type: "connect.skipped" }).screen).toEqual({ kind: "repo" });
  });

  it("switches a connect attempt to unavailable when the computer turns out to have no app connections", () => {
    const discovered = run(
      fresh(),
      { type: "task.selected", taskId: "plan-week", connectedServices: [] },
      { type: "connect.started" },
      { type: "connect.unavailable", service: "google_calendar" },
    );
    expect(discovered.screen).toEqual({ kind: "connect", taskId: "plan-week", status: "unavailable" });
    expect(run(discovered, { type: "connect.failed", service: "google_calendar" }).screen).toEqual(discovered.screen);
    expect(run(fresh(), { type: "connect.unavailable", service: "google_calendar" }).screen).toEqual({ kind: "tasks" });
  });

  it("ignores an unavailable result for an app the current task does not need", () => {
    const connecting = run(
      fresh(),
      { type: "task.selected", taskId: "plan-week", connectedServices: [] },
      { type: "connect.started" },
    );
    expect(run(connecting, { type: "connect.unavailable", service: "github" }).screen).toEqual(connecting.screen);
  });

  it("still goes straight to the work when the app is connected, even if new connections are unavailable", () => {
    const state = run(fresh(), { type: "task.selected", taskId: "work-on-code", connectedServices: ["github"], appsUnavailable: true });
    expect(state.screen).toEqual({ kind: "repo" });
  });

  it("connects GitHub and then picks a repo for Work on my code", () => {
    const picked = run(
      fresh(),
      { type: "task.selected", taskId: "work-on-code", connectedServices: [] },
      { type: "connect.started" },
      { type: "connect.succeeded", service: "github" },
    );
    expect(picked.screen).toEqual({ kind: "repo" });
    expect(picked.notice).toBe("GitHub connected");
    const started = run(picked, { type: "answer.submitted", text: "portfolio" });
    expect(started.screen).toMatchObject({ kind: "run", taskId: "work-on-code", answer: "portfolio" });
  });

  it("keeps only a validated repo link as run context, including on retry", () => {
    const repo = run(fresh(), { type: "task.selected", taskId: "work-on-code", connectedServices: ["github"] });
    const valid = run(repo, { type: "answer.submitted", text: "portfolio", context: "https://github.com/acme/portfolio.git" });
    expect(valid.screen).toMatchObject({ context: "https://github.com/acme/portfolio" });
    const failed = run(valid, { type: "run.failedToStart" }, { type: "run.retried", simpler: false });
    expect(failed.screen).toMatchObject({ context: "https://github.com/acme/portfolio" });
    const invalid = run(repo, { type: "answer.submitted", text: "portfolio", context: "https://evil.com/x/y" });
    expect(invalid.screen.kind === "run" && invalid.screen.context).toBeUndefined();
    expect(buildOnboardingPrompt({ taskId: "work-on-code", answer: "portfolio", appConnected: true, simpler: false, context: "https://github.com/acme/portfolio" }))
      .toContain("https://github.com/acme/portfolio");
  });

  it("tracks the run through admission and completion and records the first task", () => {
    const started = run(fresh(), { type: "task.selected", taskId: "research", connectedServices: [] }, { type: "answer.submitted", text: "AI agent pricing" });
    const requestId = started.screen.kind === "run" ? started.screen.requestId : -1;
    const admitted = run(started, { type: "run.admitted", requestId, chatId: "chat_1", runId: "run_1" });
    expect(admitted.screen).toMatchObject({ phase: "running", runId: "run_1" });
    expect(admitted.chatId).toBe("chat_1");
    const done = run(admitted, { type: "run.settled", runId: "run_1", outcome: "completed" });
    expect(done.screen).toMatchObject({ phase: "done" });
    expect(done.firstTaskCompleted).toBe(true);
  });

  it("starts every new task in its own chat instead of reusing the last one", () => {
    const earlier = { ...fresh(), chatId: "chat_earlier" };
    const research = run(earlier, { type: "task.selected", taskId: "research", connectedServices: [] }, { type: "answer.submitted", text: "AI agent pricing" });
    expect(research.screen).toMatchObject({ kind: "run", phase: "starting" });
    expect(research.chatId).toBeNull();
    const week = run(earlier, { type: "task.selected", taskId: "plan-week", connectedServices: ["google_calendar"] });
    expect(week.screen).toMatchObject({ kind: "run", taskId: "plan-week", phase: "starting" });
    expect(week.chatId).toBeNull();
    const code = run(
      earlier,
      { type: "task.selected", taskId: "work-on-code", connectedServices: ["github"] },
      { type: "answer.submitted", text: "matrix-os", context: "https://github.com/HamedMP/matrix-os" },
    );
    expect(code.chatId).toBeNull();
    expect(run(earlier, { type: "freeform.submitted", text: "Summarize today" }).chatId).toBeNull();
  });

  it("keeps a task's chat for its retries and follow-ups", () => {
    const started = run(fresh(), { type: "freeform.submitted", text: "Summarize today" });
    const requestId = started.screen.kind === "run" ? started.screen.requestId : -1;
    const admitted = run(started, { type: "run.admitted", requestId, chatId: "chat_task", runId: "run_1" });
    const failed = run(admitted, { type: "run.settled", runId: "run_1", outcome: "failed" });
    expect(run(failed, { type: "run.retried", simpler: true }).chatId).toBe("chat_task");
    const done = run(admitted, { type: "run.settled", runId: "run_1", outcome: "completed" });
    expect(run(done, { type: "followUp.chosen", choice: "Yes", prompt: "Do this every Monday at 8:00." }).chatId).toBe("chat_task");
  });

  it("exposes only an admitted, unsettled run for restoring after a restart", () => {
    const started = run(fresh(), { type: "task.selected", taskId: "research", connectedServices: [] }, { type: "answer.submitted", text: "Trip ideas for Lisbon" });
    expect(onboardingPendingRun(started)).toBeNull();
    const admitted = run(started, { type: "run.admitted", requestId: 1, chatId: "chat_1", runId: "run_1" });
    expect(onboardingPendingRun(admitted)).toEqual({ taskId: "research", answer: "Trip ideas for Lisbon", appConnected: true, simpler: false, runId: "run_1" });
    expect(onboardingPendingRun(run(admitted, { type: "run.settled", runId: "run_1", outcome: "completed" }))).toBeNull();
  });

  it("restores a pending run after a restart and keeps following it", () => {
    const pendingRun = { taskId: "research", answer: "Trip ideas for Lisbon", appConnected: true, simpler: false, runId: "run_1" } as const;
    const restored = initialOnboardingWidgetState({ size: "corner", firstTaskCompleted: false, chatId: "chat_1", pendingRun });
    expect(restored.screen).toMatchObject({ kind: "run", phase: "running", taskId: "research", runId: "run_1" });
    expect(restored.started).toBe(true);
    expect(onboardingRunInFlight(restored)).toBe(true);
    const done = run(restored, { type: "run.settled", runId: "run_1", outcome: "completed" });
    expect(done.screen).toMatchObject({ phase: "done" });
    expect(done.firstTaskCompleted).toBe(true);
    const failed = run(restored, { type: "run.settled", runId: "run_1", outcome: "failed" });
    const retried = run(failed, { type: "run.retried", simpler: false });
    expect(retried.screen).toMatchObject({ kind: "run", phase: "starting", answer: "Trip ideas for Lisbon" });
  });

  it("ignores a connection result for an app the current task does not need", () => {
    const calendar = run(
      fresh(),
      { type: "task.selected", taskId: "work-on-code", connectedServices: [] },
      { type: "connect.started" },
      { type: "tasks.requested" },
      { type: "task.selected", taskId: "plan-week", connectedServices: [] },
    );
    expect(run(calendar, { type: "connect.succeeded", service: "github" })).toBe(calendar);
    expect(run(calendar, { type: "connect.failed", service: "github" })).toBe(calendar);
    expect(run(calendar, { type: "connect.succeeded", service: "google_calendar" }).screen).toMatchObject({ kind: "run", taskId: "plan-week", appConnected: true });
  });

  it("forgets a chat that no longer exists and leaves a run it was following for the task list", () => {
    const pendingRun = { taskId: "research", answer: "Trip ideas for Lisbon", appConnected: true, simpler: false, runId: "run_1" } as const;
    const restored = initialOnboardingWidgetState({ size: "corner", firstTaskCompleted: false, chatId: "chat_1", pendingRun });
    expect(run(restored, { type: "chat.missing", chatId: "chat_other" })).toBe(restored);
    const gone = run(restored, { type: "chat.missing", chatId: "chat_1" });
    expect(gone.chatId).toBeNull();
    expect(gone.screen).toEqual({ kind: "tasks" });
    expect(onboardingPendingRun(gone)).toBeNull();

    const done = run(restored, { type: "run.settled", runId: "run_1", outcome: "completed" });
    const doneGone = run(done, { type: "chat.missing", chatId: "chat_1" });
    expect(doneGone.chatId).toBeNull();
    expect(doneGone.screen).toBe(done.screen);
  });

  it("ignores a pending run without its chat or with an unknown task", () => {
    const pendingRun = { taskId: "research", answer: "x", appConnected: true, simpler: false, runId: "run_1" } as const;
    expect(initialOnboardingWidgetState({ size: "corner", firstTaskCompleted: false, pendingRun }).screen).toEqual({ kind: "tasks" });
    const unknown = { ...pendingRun, taskId: "not-a-task" } as unknown as typeof pendingRun;
    expect(initialOnboardingWidgetState({ size: "corner", firstTaskCompleted: false, chatId: "chat_1", pendingRun: unknown }).screen).toEqual({ kind: "tasks" });
  });

  it("ignores admission results for a superseded request", () => {
    const started = run(fresh(), { type: "freeform.submitted", text: "Summarize today" });
    const stale = run(started, { type: "run.admitted", requestId: 999, chatId: "chat_x", runId: "run_x" });
    expect(stale).toBe(started);
  });

  it("holds new messages while a run is admitting or running, because the chat accepts one turn at a time", () => {
    const started = run(fresh(), { type: "freeform.submitted", text: "Summarize today" });
    expect(onboardingRunInFlight(started)).toBe(true);
    expect(run(started, { type: "freeform.submitted", text: "And tomorrow" })).toBe(started);
    const running = run(started, { type: "run.admitted", requestId: 1, chatId: "c", runId: "r" });
    expect(run(running, { type: "freeform.submitted", text: "And tomorrow" })).toBe(running);
    const settled = run(running, { type: "run.settled", runId: "r", outcome: "completed" });
    expect(onboardingRunInFlight(settled)).toBe(false);
    expect(run(settled, { type: "freeform.submitted", text: "And tomorrow" }).screen).toMatchObject({ kind: "run", phase: "starting", answer: "And tomorrow" });
  });

  it("queues the task while the computer starts and resumes when ready", () => {
    const started = run(fresh(), { type: "task.selected", taskId: "research", connectedServices: [] }, { type: "answer.submitted", text: "Trip ideas for Lisbon" });
    const queued = run(started, { type: "computer.waiting" });
    expect(queued.screen).toMatchObject({ phase: "waiting_computer" });
    const resumed = run(queued, { type: "computer.ready" });
    expect(resumed.screen).toMatchObject({ phase: "starting" });
    if (queued.screen.kind === "run" && resumed.screen.kind === "run") {
      expect(resumed.screen.requestId).toBeGreaterThan(queued.screen.requestId);
    }
  });

  it("offers retry and a simpler version after a failure", () => {
    const failed = run(
      fresh(),
      { type: "task.selected", taskId: "research", connectedServices: [] },
      { type: "answer.submitted", text: "AI agent pricing" },
      { type: "run.failedToStart" },
    );
    expect(failed.screen).toMatchObject({ phase: "failed" });
    expect(run(failed, { type: "run.retried", simpler: true }).screen).toMatchObject({ phase: "starting", simpler: true });
  });

  it("allows only one follow-up offer per task", () => {
    const done = run(
      fresh(),
      { type: "freeform.submitted", text: "Summarize today" },
    );
    const requestId = done.screen.kind === "run" ? done.screen.requestId : -1;
    const settled = run(done, { type: "run.admitted", requestId, chatId: "c", runId: "r" }, { type: "run.settled", runId: "r", outcome: "completed" });
    expect(settled.followUpUsed).toBe(false);
    const dismissed = run(settled, { type: "followUp.dismissed" });
    expect(dismissed.followUpUsed).toBe(true);
    const followed = run(settled, { type: "followUp.chosen", choice: "Yes", prompt: "Do this every Monday at 8:00." });
    expect(followed.echo).toBe("Yes");
    expect(followed.followUpUsed).toBe(true);
    expect(followed.screen).toMatchObject({ kind: "run", taskId: "custom", answer: "Do this every Monday at 8:00.", phase: "starting" });
  });

  it("caps free-form text before it becomes a prompt", () => {
    const state = run(fresh(), { type: "freeform.submitted", text: `  ${"x".repeat(ONBOARDING_FREEFORM_MAX_CHARS + 50)}  ` });
    expect(state.screen.kind === "run" && state.screen.answer.length).toBe(ONBOARDING_FREEFORM_MAX_CHARS);
    expect(run(fresh(), { type: "freeform.submitted", text: "   " }).screen).toEqual({ kind: "tasks" });
  });

  it("returns to the task list from any screen without ending onboarding", () => {
    const state = run(fresh(), { type: "apps.opened" }, { type: "tasks.requested" });
    expect(state.screen).toEqual({ kind: "tasks" });
  });

  it("confirms apps connected from the apps list on Done", () => {
    const state = run(fresh(), { type: "apps.opened" }, { type: "apps.closed", connectedNames: ["Calendar", "GitHub"] });
    expect(state.screen).toEqual({ kind: "tasks" });
    expect(state.notice).toBe("Calendar and GitHub connected");
    expect(state.echo).toBe("Done");
  });

  it("walks the Change the AI flow and updates the footer", () => {
    const menu = run(fresh(), { type: "ai.menuToggled" });
    expect(menu.ai).toEqual({ step: "menu" });
    const method = run(menu, { type: "ai.providerPicked", provider: "claude" });
    expect(method.ai).toEqual({ step: "method", provider: "claude" });
    const waiting = run(method, { type: "ai.methodPicked", method: "account" });
    expect(waiting.ai).toEqual({ step: "waiting", provider: "claude", status: "waiting" });
    expect(run(waiting, { type: "ai.failed" }).ai).toEqual({ step: "waiting", provider: "claude", status: "failed" });
    const key = run(method, { type: "ai.methodPicked", method: "api_key" });
    expect(key.ai).toEqual({ step: "key", provider: "claude", status: "idle" });
    const keyFailed = run(run(key, { type: "ai.keySubmitted" }), { type: "ai.failed", failure: "workspace_required" });
    expect(keyFailed.ai).toEqual({ step: "key", provider: "claude", status: "failed", failure: "workspace_required" });
    expect(run(keyFailed, { type: "ai.keySubmitted" }).ai).toEqual({ step: "key", provider: "claude", status: "saving" });
    const connected = run(key, { type: "ai.connected", provider: "claude" });
    expect(connected.ai).toBeNull();
    expect(connected.aiChoice).toBe("claude");
    expect(connected.notice).toBe("Claude connected");
    expect(connected.screen).toEqual({ kind: "tasks" });
    expect(run(method, { type: "ai.cancelled" }).ai).toBeNull();
    const switched = run(menu, { type: "ai.selected", provider: "codex" });
    expect(switched.ai).toBeNull();
    expect(switched.aiChoice).toBe("codex");
    expect(switched.notice).toBeNull();
    expect(onboardingAiLabel("codex")).toBe("ChatGPT");
  });

  it("keeps a task started during AI sign-in when that sign-in finishes", () => {
    const waiting = run(fresh(), { type: "ai.menuToggled" }, { type: "ai.providerPicked", provider: "claude" }, { type: "ai.methodPicked", method: "account" });
    const started = run(waiting, { type: "freeform.submitted", text: "Summarize today" });
    expect(started.ai).toBeNull();
    const connected = run(started, { type: "ai.connected", provider: "claude" });
    expect(connected.screen).toEqual(started.screen);
    expect(connected.echo).toBe("Summarize today");
    expect(connected.aiChoice).toBe("claude");
    expect(connected.notice).toBe("Claude connected");
    const requestId = connected.screen.kind === "run" ? connected.screen.requestId : -1;
    const done = run(connected, { type: "run.admitted", requestId, chatId: "c", runId: "r" }, { type: "run.settled", runId: "r", outcome: "completed" });
    expect(done.screen).toMatchObject({ kind: "run", phase: "done" });
    expect(done.firstTaskCompleted).toBe(true);

    const queued = run(started, { type: "computer.waiting" }, { type: "ai.connected", provider: "claude" });
    expect(queued.screen).toMatchObject({ kind: "run", phase: "waiting_computer" });

    const finished = run(done, { type: "ai.connected", provider: "codex" });
    expect(finished.screen).toEqual({ kind: "tasks" });
  });

  it("hands off to Settings only from an in-progress connect step", () => {
    const method = run(fresh(), { type: "ai.menuToggled" }, { type: "ai.providerPicked", provider: "codex" });
    const waiting = run(method, { type: "ai.methodPicked", method: "account" });
    expect(run(waiting, { type: "ai.needsSettings" }).ai).toEqual({ step: "settings", provider: "codex" });
    const key = run(method, { type: "ai.methodPicked", method: "api_key" }, { type: "ai.keySubmitted" });
    expect(run(key, { type: "ai.needsSettings" }).ai).toEqual({ step: "settings", provider: "codex" });
    expect(run(fresh(), { type: "ai.needsSettings" }).ai).toBeNull();
    expect(run(waiting, { type: "ai.cancelled" }, { type: "ai.needsSettings" }).ai).toBeNull();
  });

  it("counts results that finish while minimized and clears them on open", () => {
    const minimized = run(fresh(), { type: "freeform.submitted", text: "Summarize today" }, { type: "size.changed", size: "bubble" });
    const requestId = minimized.screen.kind === "run" ? minimized.screen.requestId : -1;
    const done = run(minimized, { type: "run.admitted", requestId, chatId: "c", runId: "r" }, { type: "run.settled", runId: "r", outcome: "completed" });
    expect(done.unread).toBe(1);
    expect(run(done, { type: "size.changed", size: "corner" }).unread).toBe(0);
  });
});

function source(overrides: Partial<OnboardingRunSource["runs"][number]> = {}, messages: OnboardingRunSource["messages"] = []): OnboardingRunSource {
  return {
    runs: [{ id: "run_1", status: "running", ...overrides }],
    messages,
  };
}

describe("deriveOnboardingRunView", () => {
  it("projects tool calls into a bounded work log with checks", () => {
    const view = deriveOnboardingRunView(source({}, [
      { runId: "run_1", role: "assistant", parts: [{ type: "tool_request", toolCallId: "t1", name: "web_search", label: "Searched 24 sources" }] },
      { runId: "run_1", role: "tool", parts: [{ type: "tool_result", toolCallId: "t1", outcome: "success", truncated: false }] },
      { runId: "run_1", role: "assistant", parts: [{ type: "tool_request", toolCallId: "t2", name: "fetch", label: "Read 9 pages" }] },
      { runId: "other", role: "assistant", parts: [{ type: "tool_request", toolCallId: "x", name: "x", label: "Elsewhere" }] },
    ]), "run_1");
    expect(view.status).toBe("running");
    expect(view.steps).toEqual([
      { id: "t1", label: "Searched 24 sources", state: "done" },
      { id: "t2", label: "Read 9 pages", state: "running" },
    ]);
  });

  it("returns the final assistant text when the run completes", () => {
    const view = deriveOnboardingRunView(source({ status: "completed" }, [
      { runId: "run_1", role: "assistant", parts: [{ type: "text", text: "Prices range from $0 to $200 per seat.\n\nMore detail." }] },
    ]), "run_1");
    expect(view.status).toBe("completed");
    expect(view.resultText).toBe("Prices range from $0 to $200 per seat.\n\nMore detail.");
    expect(view.resultSummary).toBe("Prices range from $0 to $200 per seat.\nMore detail.");
  });

  it("joins every text part of the final answer and keeps the following detail", () => {
    const view = deriveOnboardingRunView(source({ status: "completed" }, [
      { runId: "run_1", role: "assistant", parts: [{ type: "text", text: "Let me look that up." }, { type: "tool_request", toolCallId: "t1", name: "web_search", label: "Searched 24 sources" }] },
      { runId: "run_1", role: "tool", parts: [{ type: "tool_result", toolCallId: "t1", outcome: "success", truncated: false }] },
      { runId: "run_1", role: "assistant", parts: [{ type: "text", text: "Prices range from $0 to " }, { type: "text", text: "$200 per seat.\n\nMore detail." }] },
    ]), "run_1");
    expect(view.resultText).toBe("Prices range from $0 to $200 per seat.\n\nMore detail.");
    expect(view.resultSummary).toBe("Prices range from $0 to $200 per seat.\nMore detail.");
  });

  it("strips markdown from the summary line", () => {
    const summary = (text: string) => deriveOnboardingRunView(source({ status: "completed" }, [
      { runId: "run_1", role: "assistant", parts: [{ type: "text", text }] },
    ]), "run_1").resultSummary;
    expect(summary("**I couldn't research Lisbon:** web search is _blocked_.")).toBe("I couldn't research Lisbon: web search is blocked.");
    expect(summary("## Lisbon in `3 days`")).toBe("Lisbon in 3 days");
    expect(summary("- See [Time Out](https://example.com/lisbon) for ~~old~~ picks")).toBe("See Time Out for old picks");
    expect(summary("> **Top pick:** Alfama")).toBe("Top pick: Alfama");
    expect(summary("1. Belém\n2. Sintra")).toBe("Belém\nSintra");
    expect(summary("snake_case_name stays")).toBe("snake_case_name stays");
  });

  it("keeps more than the first line, then stops around 600 characters", () => {
    const first = `${"Lisbon".repeat(30)}.`;
    const second = `${"Alfama".repeat(30)}.`;
    const third = `${"Belem".repeat(80)}.`;
    const summary = deriveOnboardingRunView(source({ status: "completed" }, [
      { runId: "run_1", role: "assistant", parts: [{ type: "text", text: `${first}\n${second}\n${third}` }] },
    ]), "run_1").resultSummary ?? "";
    expect(summary.startsWith(first)).toBe(true);
    expect(summary).toContain(second);
    expect(summary.length).toBeGreaterThan(160);
    expect(summary.length).toBeLessThanOrEqual(600);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("marks the failing step red and never fails silently", () => {
    const failedTool = deriveOnboardingRunView(source({ status: "failed" }, [
      { runId: "run_1", role: "assistant", parts: [{ type: "tool_request", toolCallId: "t1", name: "write", label: "Wrote the brief" }] },
      { runId: "run_1", role: "tool", parts: [{ type: "tool_result", toolCallId: "t1", outcome: "failed", truncated: false }] },
    ]), "run_1", { failedStepLabel: "Couldn't write the brief" });
    expect(failedTool.status).toBe("failed");
    expect(failedTool.steps.at(-1)).toEqual({ id: "t1", label: "Wrote the brief", state: "failed" });

    const noSteps = deriveOnboardingRunView(source({ status: "failed" }), "run_1", { failedStepLabel: "Couldn't write the brief" });
    expect(noSteps.steps).toEqual([{ id: "run-failed", label: "Couldn't write the brief", state: "failed" }]);
  });

  it("keeps the failure visible when an early failed step falls out of the six-step log", () => {
    const messages: OnboardingRunSource["messages"] = Array.from({ length: 7 }, (_, index) => [
      { runId: "run_1", role: "assistant", parts: [{ type: "tool_request", toolCallId: `t${index}`, name: "n", label: `Step ${index}` }] },
      { runId: "run_1", role: "tool", parts: [{ type: "tool_result", toolCallId: `t${index}`, outcome: index === 0 ? "failed" : "success", truncated: false }] },
    ]).flat();
    const view = deriveOnboardingRunView(source({ status: "failed" }, messages), "run_1", { failedStepLabel: "Couldn't finish the brief" });
    expect(view.steps).toHaveLength(6);
    expect(view.steps.map((step) => step.label)).toEqual(["Step 2", "Step 3", "Step 4", "Step 5", "Step 6", "Couldn't finish the brief"]);
    expect(view.steps.at(-1)).toEqual({ id: "run-failed", label: "Couldn't finish the brief", state: "failed" });
  });

  it("caps the work log at the most recent six steps", () => {
    const messages = Array.from({ length: 9 }, (_, index) => ({
      runId: "run_1",
      role: "assistant" as const,
      parts: [{ type: "tool_request" as const, toolCallId: `t${index}`, name: "n", label: `Step ${index}` }],
    }));
    const view = deriveOnboardingRunView(source({}, messages), "run_1");
    expect(view.steps).toHaveLength(6);
    expect(view.steps[0]?.label).toBe("Step 3");
  });

  it("reports a pending view when the run is not in the detail yet", () => {
    expect(deriveOnboardingRunView({ runs: [], messages: [] }, "run_1")).toEqual({ status: "pending", steps: [] });
  });
});

describe("buildOnboardingPrompt", () => {
  it("builds task prompts from catalog constants and the chosen answer", () => {
    const prompt = buildOnboardingPrompt({ taskId: "research", answer: "AI agent pricing", appConnected: true, simpler: false });
    expect(prompt).toContain("AI agent pricing");
    expect(buildOnboardingPrompt({ taskId: "plan-week", answer: "", appConnected: false, simpler: false }))
      .not.toContain("Google Calendar data");
    expect(buildOnboardingPrompt({ taskId: "research", answer: "AI agent pricing", appConnected: true, simpler: true }))
      .not.toBe(prompt);
  });

  it("passes free-form text through unchanged", () => {
    expect(buildOnboardingPrompt({ taskId: "custom", answer: "Summarize today", appConnected: false, simpler: false })).toBe("Summarize today");
  });
});

describe("onboardingChatTitle", () => {
  it("names each new chat after its task so Chat can tell them apart", () => {
    expect(onboardingChatTitle({ taskId: "research", answer: "AI agent pricing" })).toBe("Research: AI agent pricing");
    expect(onboardingChatTitle({ taskId: "plan-week", answer: "" })).toBe("Plan my week");
    expect(onboardingChatTitle({ taskId: "build-website", answer: "Portfolio" })).toBe("Website: Portfolio");
    expect(onboardingChatTitle({ taskId: "work-on-code", answer: "matrix-os" })).toBe("Code: matrix-os");
    expect(onboardingChatTitle({ taskId: "custom", answer: "Summarize today" })).toBe("Summarize today");
  });

  it("keeps a follow-up's result title and clips long requests", () => {
    expect(onboardingChatTitle({ taskId: "custom", answer: "Do this every Monday", title: "Week plan" })).toBe("Week plan");
    const long = onboardingChatTitle({ taskId: "research", answer: "x".repeat(200) });
    expect(long).toHaveLength(60);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("parseOnboardingRepoUrl", () => {
  it("accepts only github.com owner/repo URLs", () => {
    expect(parseOnboardingRepoUrl("https://github.com/acme/portfolio")).toEqual({ url: "https://github.com/acme/portfolio", name: "portfolio" });
    expect(parseOnboardingRepoUrl("https://github.com/acme/portfolio.git")).toEqual({ url: "https://github.com/acme/portfolio", name: "portfolio" });
    expect(parseOnboardingRepoUrl("http://github.com/acme/portfolio")).toBeNull();
    expect(parseOnboardingRepoUrl("https://evil.com/acme/portfolio")).toBeNull();
    expect(parseOnboardingRepoUrl("https://github.com/acme")).toBeNull();
  });
});

describe("deriveOnboardingBubble", () => {
  it("shows progress while working and the ready line with a count when done", () => {
    const working = run(fresh(), { type: "task.selected", taskId: "research", connectedServices: [] }, { type: "answer.submitted", text: "AI agent pricing" });
    expect(deriveOnboardingBubble(working, { status: "running", steps: [] })).toEqual({
      tone: "working", title: "Working…", subtitle: "Researching AI agent pricing", count: 0,
    });
    const requestId = working.screen.kind === "run" ? working.screen.requestId : -1;
    const done = run(working, { type: "size.changed", size: "bubble" }, { type: "run.admitted", requestId, chatId: "c", runId: "r" }, { type: "run.settled", runId: "r", outcome: "completed" });
    expect(deriveOnboardingBubble(done, { status: "completed", steps: [] })).toEqual({
      tone: "ready", title: "Your brief is ready", subtitle: "AI agent pricing", count: 1,
    });
  });

  it("stops announcing a result the user already saw", () => {
    const working = run(fresh(), { type: "task.selected", taskId: "research", connectedServices: [] }, { type: "answer.submitted", text: "AI agent pricing" });
    const requestId = working.screen.kind === "run" ? working.screen.requestId : -1;
    const seen = run(working, { type: "run.admitted", requestId, chatId: "c", runId: "r" }, { type: "run.settled", runId: "r", outcome: "completed" }, { type: "followUp.dismissed" }, { type: "size.changed", size: "bubble" });
    expect(deriveOnboardingBubble(seen, { status: "completed", steps: [] })).toEqual({
      tone: "idle", title: "Pick up where we left off", subtitle: "AI agent pricing", count: 0,
    });
  });

  it("counts an unanswered follow-up as the one step left", () => {
    const working = run(fresh(), { type: "task.selected", taskId: "plan-week", connectedServices: ["google_calendar"] });
    const requestId = working.screen.kind === "run" ? working.screen.requestId : -1;
    const seen = run(working, { type: "run.admitted", requestId, chatId: "c", runId: "r" }, { type: "run.settled", runId: "r", outcome: "completed" }, { type: "size.changed", size: "bubble" });
    expect(deriveOnboardingBubble(seen, { status: "completed", steps: [] })).toEqual({
      tone: "idle", title: "Pick up where we left off", subtitle: "1 step left · Schedule your weekly plan", count: 1,
    });
    for (const task of ONBOARDING_TASKS) expect(task.nextStep.length).toBeGreaterThan(0);
  });

  it("names typed tasks and follow-ups after what the user asked for", () => {
    const typed = run(fresh(), { type: "freeform.submitted", text: "Trip ideas for Lisbon" });
    const requestId = typed.screen.kind === "run" ? typed.screen.requestId : -1;
    const done = run(typed, { type: "size.changed", size: "bubble" }, { type: "run.admitted", requestId, chatId: "c", runId: "r" }, { type: "run.settled", runId: "r", outcome: "completed" });
    expect(deriveOnboardingBubble(done, { status: "completed", steps: [] })).toMatchObject({ title: "Your result is ready", subtitle: "Trip ideas for Lisbon", count: 1 });

    const followed = run(done, { type: "followUp.chosen", choice: "Yes", prompt: "Watch this topic every week." });
    expect(followed.screen).toMatchObject({ kind: "run", title: "Trip ideas for Lisbon" });
    expect(deriveOnboardingBubble(followed, { status: "running", steps: [] })).toMatchObject({ title: "Working…", subtitle: "Trip ideas for Lisbon" });

    const long = run(fresh(), { type: "freeform.submitted", text: "x".repeat(120) });
    expect(long.screen.kind === "run" && onboardingRunTitle(long.screen)).toBe(`${"x".repeat(47)}…`);
  });

  it("invites the user back while setup is unfinished", () => {
    expect(deriveOnboardingBubble(fresh(), null)).toEqual({
      tone: "idle", title: "Pick up where we left off", subtitle: "What should I start on?", count: 0,
    });
  });
});

describe("starter tasks while a run is active (spec 639)", () => {
  it("ignores a new starter task while a task is starting or running, keeping its progress", () => {
    const started = run(fresh(), { type: "task.selected", taskId: "research", connectedServices: [] }, { type: "answer.submitted", text: "AI agent pricing" });
    expect(started.screen.kind).toBe("run");
    const again = run(started, { type: "task.selected", taskId: "build-website", connectedServices: [] });
    expect(again).toBe(started);
  });

  it("accepts a new starter task once the run has finished", () => {
    const started = run(fresh(), { type: "task.selected", taskId: "research", connectedServices: [] }, { type: "answer.submitted", text: "AI agent pricing" });
    const finished = started.screen.kind === "run"
      ? { ...started, screen: { ...started.screen, phase: "done" as const } }
      : started;
    const next = run(finished, { type: "task.selected", taskId: "build-website", connectedServices: [] });
    expect(next.screen.kind).toBe("question");
  });
});
