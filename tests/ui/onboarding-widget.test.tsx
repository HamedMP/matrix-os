// @vitest-environment jsdom
import React, { useReducer } from "react";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  initialOnboardingWidgetState,
  reduceOnboardingWidget,
  type OnboardingAiChoice,
  type OnboardingAiProvider,
  type OnboardingRunView,
  type OnboardingWidgetEvent,
  type OnboardingWidgetState,
} from "../../packages/contracts/src/index.js";
import { DEFAULT_ONBOARDING_POSITION, OnboardingWidget } from "../../packages/ui/src/onboarding-widget/index.js";
import type {
  OnboardingWidgetActions,
  OnboardingWidgetApp,
  OnboardingWidgetPrefs,
  OnboardingWidgetProps,
} from "../../packages/ui/src/onboarding-widget/index.js";

const APPS: OnboardingWidgetApp[] = [
  { id: "google_calendar", name: "Google Calendar", category: "work", status: "available", logoUrl: "https://example.test/gcal.png" },
  { id: "gmail", name: "Gmail", category: "personal", status: "connected" },
  { id: "github", name: "GitHub", category: "dev", status: "available" },
];

function makeActions(): OnboardingWidgetActions {
  return {
    dispatch: vi.fn(),
    connectApp: vi.fn(),
    openResult: vi.fn(),
    openFullChat: vi.fn(),
    openSettings: vi.fn(),
    addCredits: vi.fn(),
    startAiSignIn: vi.fn(),
    reopenAiSignIn: vi.fn(),
    cancelAiSignIn: vi.fn(),
    submitAiKey: vi.fn(),
    submitAiCode: vi.fn(),
    changePrefs: vi.fn(),
  };
}

const REPOS = [{ name: "portfolio", url: "https://github.com/sahar/portfolio", updatedLabel: "2h ago" }];

function Harness({
  actions, initial, runView = null, creditsExhausted = false, events = [], aiSignInNeedsCode = false,
  appsUnavailable = false, apps = APPS, repos = REPOS, activeAi = "matrix", followUpAi = null, matrixAvailable = true, connectedProviders = [],
  prefs = { keepInCorner: true, position: DEFAULT_ONBOARDING_POSITION, showOnLogin: true }, onSizeChange,
}: {
  prefs?: OnboardingWidgetPrefs;
  onSizeChange?: OnboardingWidgetProps["onSizeChange"];
  repos?: OnboardingWidgetProps["repos"];
  actions: OnboardingWidgetActions;
  apps?: OnboardingWidgetApp[];
  initial?: OnboardingWidgetState;
  runView?: OnboardingRunView | null;
  creditsExhausted?: boolean;
  events?: OnboardingWidgetEvent[];
  aiSignInNeedsCode?: boolean;
  appsUnavailable?: boolean;
  activeAi?: OnboardingAiChoice;
  followUpAi?: OnboardingAiChoice | null;
  matrixAvailable?: boolean;
  connectedProviders?: readonly OnboardingAiProvider[];
}) {
  const [state, dispatch] = useReducer(
    reduceOnboardingWidget,
    initial ?? initialOnboardingWidgetState({ size: "corner", firstTaskCompleted: false }),
    (start) => events.reduce(reduceOnboardingWidget, start),
  );
  const wired: OnboardingWidgetActions = {
    ...actions,
    dispatch: (event) => {
      (actions.dispatch as ReturnType<typeof vi.fn>)(event);
      dispatch(event);
    },
  };
  return (
    <OnboardingWidget
      state={state}
      actions={wired}
      userName="Sahar"
      apps={apps}
      repos={repos}
      runView={runView}
      activeAi={activeAi}
      followUpAi={followUpAi}
      matrixAvailable={matrixAvailable}
      connectedProviders={connectedProviders}
      creditsExhausted={creditsExhausted}
      aiSignInNeedsCode={aiSignInNeedsCode}
      appsUnavailable={appsUnavailable}
      prefs={prefs}
      onSizeChange={onSizeChange}
    />
  );
}

describe("OnboardingWidget", () => {
  it("shows a working step before the agent reports any tool activity", () => {
    const research: OnboardingWidgetEvent[] = [
      { type: "task.selected", taskId: "research", connectedServices: [] },
      { type: "answer.submitted", text: "Trip ideas for Lisbon" },
    ];
    const { unmount } = render(<Harness actions={makeActions()} events={research} runView={{ status: "running", steps: [] }} />);
    expect(within(screen.getByRole("list", { name: "Work log" })).getByText("Researching Trip ideas for Lisbon")).toBeInTheDocument();
    unmount();

    render(<Harness actions={makeActions()} events={[{ type: "freeform.submitted", text: "Yes" }]} runView={null} />);
    expect(within(screen.getByRole("list", { name: "Work log" })).getByText("Working on it")).toBeInTheDocument();
  });

  it("renders the first-run greeting, four tasks, app tags and the AI line", () => {
    render(<Harness actions={makeActions()} />);
    expect(screen.getByText("Hey Sahar 👋")).toBeInTheDocument();
    expect(screen.getByText(/I'm Matrix\. I work in your apps, even while you're away\./)).toBeInTheDocument();
    for (const label of ["Research anything", "Plan my week", "Build a website", "Work on my code"]) {
      expect(screen.getByRole("button", { name: new RegExp(label) })).toBeInTheDocument();
    }
    expect(screen.getByText("Needs Calendar")).toBeInTheDocument();
    expect(screen.getByText("Needs GitHub")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect apps first" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Or type what you need…")).toBeInTheDocument();
    expect(screen.getByText(/Matrix AI ·/)).toBeInTheDocument();
    expect(screen.queryByText(/Online/)).not.toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/\bbot\b|\blibrary\b/i);
  });

  it("asks for only the needed app and connects it", () => {
    const actions = makeActions();
    render(<Harness actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: /Plan my week/ }));
    expect(screen.getByText("I need your calendar for this.")).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(actions.connectApp).toHaveBeenCalledWith("google_calendar");
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.getByText("Working…")).toBeInTheDocument();
  });

  it("says app connections aren't available instead of offering a sign-in that can't work", () => {
    const actions = makeActions();
    render(<Harness actions={actions} appsUnavailable />);
    expect(screen.queryByRole("button", { name: "Connect apps first" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Work on my code/ }));
    expect(actions.dispatch).toHaveBeenCalledWith({ type: "task.selected", taskId: "work-on-code", connectedServices: [], appsUnavailable: true });
    expect(screen.getByText("App connections aren't available on this computer")).toBeInTheDocument();
    expect(screen.queryByText("Sign-in didn't finish")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Connect|Try again/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(actions.connectApp).not.toHaveBeenCalled();
    expect(screen.getByText("portfolio")).toBeInTheDocument();
  });

  it("updates an open connect card once the computer turns out to have no app connections", () => {
    const events: OnboardingWidgetEvent[] = [{ type: "task.selected", taskId: "work-on-code", connectedServices: [] }];
    const { rerender } = render(<Harness actions={makeActions()} events={events} />);
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    rerender(<Harness actions={makeActions()} events={events} appsUnavailable />);
    expect(screen.getByText("App connections aren't available on this computer")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("starts research from a chip and shows the working status", () => {
    render(<Harness actions={makeActions()} />);
    fireEvent.click(screen.getByRole("button", { name: /Research anything/ }));
    expect(screen.getByText("Sure. What topic?")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Type a topic…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "AI agent pricing" }));
    expect(screen.getByText("Working…")).toBeInTheDocument();
  });

  it("minimizes on Escape and shows progress in the bubble", () => {
    render(<Harness actions={makeActions()} events={[{ type: "freeform.submitted", text: "Summarize today" }]} />);
    fireEvent.keyDown(screen.getByPlaceholderText("Or type what you need…"), { key: "Escape" });
    const bubble = screen.getByRole("button", { name: /Open Matrix/ });
    expect(within(bubble).getByText("Working…")).toBeInTheDocument();
    expect(within(bubble).getByText("Summarize today")).toBeInTheDocument();
    fireEvent.click(bubble);
    expect(screen.getByRole("region", { name: "Matrix" })).toBeInTheDocument();
  });

  it("returns focus to the bubble after Escape so the keyboard can reopen it", () => {
    render(<Harness actions={makeActions()} />);
    fireEvent.keyDown(screen.getByPlaceholderText("Or type what you need…"), { key: "Escape" });
    expect(screen.getByRole("button", { name: /Open Matrix/ })).toHaveFocus();
  });

  it("keeps typing open but holds the message while a task is still running", () => {
    const actions = makeActions();
    render(<Harness actions={actions} events={[{ type: "freeform.submitted", text: "Summarize today" }]} />);
    const input = screen.getByPlaceholderText("Or type what you need…") as HTMLInputElement;
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "And tomorrow" } });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.submit(input.closest("form")!);
    expect(actions.dispatch).not.toHaveBeenCalledWith({ type: "freeform.submitted", text: "And tomorrow" });
    expect(input.value).toBe("And tomorrow");
  });

  it("closes the More and Change AI menus on a click outside them while the widget stays pinned", () => {
    render(<Harness actions={makeActions()} />);
    const input = screen.getByPlaceholderText("Or type what you need…");
    const more = screen.getByRole("button", { name: "More" });

    fireEvent.click(more);
    fireEvent.pointerDown(within(screen.getByRole("menu", { name: "Matrix options" })).getByText("Show on every login"));
    expect(screen.getByRole("menu", { name: "Matrix options" })).toBeInTheDocument();
    fireEvent.pointerDown(input);
    expect(screen.queryByRole("menu", { name: "Matrix options" })).not.toBeInTheDocument();

    fireEvent.click(more);
    fireEvent.pointerDown(more);
    fireEvent.click(more);
    expect(screen.queryByRole("menu", { name: "Matrix options" })).not.toBeInTheDocument();

    const change = screen.getByRole("button", { name: "Change" });
    fireEvent.click(change);
    fireEvent.click(more);
    expect(screen.getByRole("menu", { name: "Matrix options" })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "Change AI" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menu", { name: "Matrix options" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Matrix" })).toBeInTheDocument();

    fireEvent.click(change);
    fireEvent.pointerDown(change);
    fireEvent.click(change);
    expect(screen.queryByRole("menu", { name: "Change AI" })).not.toBeInTheDocument();
  });

  it("moves focus into the More and Change AI menus and back to their buttons on Escape", () => {
    render(<Harness actions={makeActions()} />);
    const more = screen.getByRole("button", { name: "More" });
    more.focus();
    fireEvent.click(more);
    const options = screen.getByRole("menu", { name: "Matrix options" });
    expect(within(options).getByRole("menuitemcheckbox", { name: /Keep in the corner/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Matrix options" })).not.toBeInTheDocument();
    expect(more).toHaveFocus();

    const change = screen.getByRole("button", { name: "Change" });
    change.focus();
    fireEvent.click(change);
    expect(within(screen.getByRole("menu", { name: "Change AI" })).getByRole("menuitemradio", { name: /Matrix AI/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Change AI" })).not.toBeInTheDocument();
    expect(change).toHaveFocus();
    expect(screen.getByRole("region", { name: "Matrix" })).toBeInTheDocument();
  });

  it("returns focus to the More button even when clicking it did not focus it", () => {
    render(<Harness actions={makeActions()} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.getByRole("button", { name: "More" })).toHaveFocus();
  });

  it("leaves focus where the user clicked when a menu closes from an outside click", () => {
    render(<Harness actions={makeActions()} />);
    const input = screen.getByPlaceholderText("Or type what you need…");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    input.focus();
    fireEvent.pointerDown(input);
    expect(screen.queryByRole("menu", { name: "Matrix options" })).not.toBeInTheDocument();
    expect(input).toHaveFocus();
  });

  it("opens full chat from the menu only, leaving Cmd/Ctrl+Shift+K to the host", () => {
    const actions = makeActions();
    render(<Harness actions={actions} />);
    fireEvent.keyDown(window, { key: "K", shiftKey: true, metaKey: true });
    fireEvent.keyDown(window, { key: "k", shiftKey: true, ctrlKey: true });
    expect(actions.openFullChat).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const fullChat = within(screen.getByRole("menu", { name: "Matrix options" })).getByRole("menuitem", { name: "Open as full chat" });
    expect(fullChat.querySelector("kbd")).toBeNull();
    fireEvent.click(fullChat);
    expect(actions.openFullChat).toHaveBeenCalledTimes(1);
  });

  it("shows which AI is in use on the task list and hides it mid-task", () => {
    render(<Harness actions={makeActions()} />);
    expect(screen.getByText(/Matrix AI ·/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Research anything/ }));
    expect(screen.queryByText(/Matrix AI ·/)).not.toBeInTheDocument();
  });

  it("walks Change AI to API key entry and clears the key after submit", () => {
    const actions = makeActions();
    render(<Harness actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const menu = screen.getByRole("menu", { name: "Change AI" });
    expect(within(menu).getByText("Free to start")).toBeInTheDocument();
    expect(within(menu).getByText("ChatGPT / Codex")).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /Claude/ }));
    expect(screen.getByText("Connect Claude to use it here.")).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /API key/ }));
    expect(screen.getByText("Stored on your computer only.")).toBeInTheDocument();
    const input = screen.getByLabelText("Anthropic API key") as HTMLInputElement;
    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input, { target: { value: "sk-ant-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(actions.submitAiKey).toHaveBeenCalledWith("claude", "sk-ant-test");
    expect(input.value).toBe("");
  });

  it("names the AI that will really run while Matrix AI can't run on this computer", () => {
    render(<Harness actions={makeActions()} activeAi="claude" matrixAvailable={false} connectedProviders={["claude"]} />);
    expect(screen.getByText(/Claude ·/)).toBeInTheDocument();
    expect(screen.queryByText(/Matrix AI ·/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    const menu = screen.getByRole("menu", { name: "Change AI" });
    const matrix = within(menu).getByRole("menuitemradio", { name: /Matrix AI/ });
    expect(matrix).toBeDisabled();
    expect(within(matrix).getByText("Not available on this computer")).toBeInTheDocument();
    expect(within(menu).getByRole("menuitemradio", { name: /Claude/ })).toHaveAttribute("aria-checked", "true");
  });

  it("says so when no AI can run here yet", () => {
    render(<Harness actions={makeActions()} matrixAvailable={false} />);
    expect(screen.getByText(/Matrix AI isn't available here ·/)).toBeInTheDocument();
  });

  it("offers to keep the AI in use, not Matrix AI, when leaving a connect flow", () => {
    const pick = (provider: OnboardingAiProvider): OnboardingWidgetEvent[] => [{ type: "ai.menuToggled" }, { type: "ai.providerPicked", provider }];
    const { unmount } = render(<Harness actions={makeActions()} activeAi="claude" matrixAvailable={false} connectedProviders={["claude"]} events={pick("codex")} />);
    expect(screen.getByRole("button", { name: "Keep Claude" })).toBeInTheDocument();
    unmount();
    render(<Harness actions={makeActions()} matrixAvailable={false} events={pick("claude")} />);
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
  });

  it("shows the coding agent that will run the code follow-up", () => {
    const done: OnboardingWidgetEvent[] = [
      { type: "task.selected", taskId: "work-on-code", connectedServices: ["github"] },
      { type: "answer.submitted", text: "portfolio", context: "https://github.com/sahar/portfolio" },
      { type: "run.admitted", requestId: 1, chatId: "chat_1", runId: "run_1" },
      { type: "run.settled", runId: "run_1", outcome: "completed" },
    ];
    // Matrix AI is ready again, but the code chat ran on Claude, so its follow-up stays there.
    const { unmount } = render(<Harness actions={makeActions()} activeAi="matrix" followUpAi="claude" connectedProviders={["claude"]} events={done} runView={{ status: "completed", steps: [] }} />);
    expect(screen.getByText("Using Claude Code")).toBeInTheDocument();
    expect(screen.queryByText(/Using Matrix AI/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change" })).not.toBeInTheDocument();
    unmount();
    render(<Harness actions={makeActions()} activeAi="matrix" events={done} runView={{ status: "completed", steps: [] }} />);
    expect(screen.queryByText(/^Using /)).not.toBeInTheDocument();
  });

  const claudeAccount: OnboardingWidgetEvent[] = [
    { type: "ai.menuToggled" },
    { type: "ai.providerPicked", provider: "claude" },
    { type: "ai.methodPicked", method: "account" },
  ];

  it("takes the code from Claude's sign-in page and finishes there", () => {
    const actions = makeActions();
    render(<Harness actions={actions} events={claudeAccount} aiSignInNeedsCode />);
    const input = screen.getByLabelText("Paste the sign-in code") as HTMLInputElement;
    expect(input).toHaveAttribute("type", "password");
    fireEvent.change(input, { target: { value: "  code#123  " } });
    fireEvent.click(screen.getByRole("button", { name: "Finish connecting" }));
    expect(actions.submitAiCode).toHaveBeenCalledWith("code#123");
    expect(input.value).toBe("");
    expect(screen.getByRole("button", { name: "Finishing sign-in…" })).toBeDisabled();
  });

  it("sends the user to Settings when the AI can't be connected from here", () => {
    const actions = makeActions();
    render(<Harness actions={actions} events={[...claudeAccount, { type: "ai.needsSettings" }]} />);
    expect(screen.getByText("Finish connecting Claude in Settings.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(actions.openSettings).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep Matrix AI" }));
    expect(screen.queryByText("Finish connecting Claude in Settings.")).not.toBeInTheDocument();
  });

  it("asks for an OK in chat when the run is waiting on the user", () => {
    const actions = makeActions();
    const running: OnboardingWidgetEvent[] = [
      { type: "task.selected", taskId: "research", connectedServices: [] },
      { type: "answer.submitted", text: "Lisbon" },
      { type: "run.admitted", requestId: 1, chatId: "chat_1", runId: "run_1" },
    ];
    render(<Harness actions={actions} events={running} runView={{ status: "waiting", steps: [{ id: "t1", label: "Searching the web", state: "running" }] }} />);
    expect(screen.getByText("I need your OK to keep going.")).toBeInTheDocument();
    expect(screen.getByText("Needs your OK")).toBeInTheDocument();
    expect(screen.queryByText("Working…")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open in chat" }));
    expect(actions.openFullChat).toHaveBeenCalled();
  });

  it("shows the result, then exactly one follow-up", () => {
    const actions = makeActions();
    const events: OnboardingWidgetEvent[] = [
      { type: "task.selected", taskId: "research", connectedServices: [] },
      { type: "answer.submitted", text: "AI agent pricing" },
      { type: "run.admitted", requestId: 1, chatId: "chat_1", runId: "run_1" },
      { type: "run.settled", runId: "run_1", outcome: "completed" },
    ];
    const summary = "Lisbon works best as a short walk between neighborhoods. Alfama for the first nights, then Belém, with one day left for Sintra.";
    render(<Harness actions={actions} events={events} runView={{ status: "completed", steps: [{ id: "t1", label: "Searched 24 sources", state: "done" }], resultSummary: summary }} />);
    expect(screen.getByText("Your brief is ready.")).toBeInTheDocument();
    expect(screen.getByText(summary)).toBeInTheDocument();
    expect(screen.getByText("Searched 24 sources")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open in Chats" }));
    expect(actions.openResult).toHaveBeenCalled();
    expect(screen.getByText("Watch this topic weekly?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByText("Watch this topic weekly?")).not.toBeInTheDocument();
  });

  it("offers credits only after a result when free credits are used", () => {
    const events: OnboardingWidgetEvent[] = [
      { type: "freeform.submitted", text: "Summarize today" },
      { type: "run.admitted", requestId: 1, chatId: "c", runId: "r" },
      { type: "run.settled", runId: "r", outcome: "completed" },
    ];
    render(<Harness actions={makeActions()} events={events} creditsExhausted runView={{ status: "completed", steps: [] }} />);
    expect(screen.getByText("You've used your free credits.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add credits" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use my Claude or ChatGPT" })).toBeInTheDocument();
  });

  it("offers retry and a simpler version after a failure", () => {
    const events: OnboardingWidgetEvent[] = [
      { type: "task.selected", taskId: "research", connectedServices: [] },
      { type: "answer.submitted", text: "AI agent pricing" },
      { type: "run.failedToStart" },
    ];
    render(<Harness actions={makeActions()} events={events} />);
    expect(screen.getByText("Couldn't write the brief")).toBeInTheDocument();
    expect(screen.getByText("I couldn't finish this one.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try a simpler version" }));
    expect(screen.getByText("Working…")).toBeInTheDocument();
  });

  it("lists apps with Connected chips and confirms only apps connected on this visit", () => {
    const actions = makeActions();
    const { rerender } = render(<Harness actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect apps first" }));
    expect(screen.getByText("Connect the apps you use.")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search apps"), { target: { value: "git" } });
    expect(screen.queryByText("Gmail")).not.toBeInTheDocument();

    fireEvent.keyDown(screen.getByLabelText("Search apps"), { key: "Escape" });
    const calendarConnected = APPS.map((app) => (app.id === "google_calendar" ? { ...app, status: "connected" as const } : app));
    rerender(<Harness actions={actions} apps={calendarConnected} />);
    fireEvent.click(screen.getByRole("button", { name: /Open Matrix/ }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(actions.dispatch).toHaveBeenLastCalledWith({ type: "apps.closed", connectedNames: ["Google Calendar"] });
    expect(screen.getByText("Google Calendar connected")).toBeInTheDocument();
  });

  it("does not claim earlier connections when Done is pressed right away", () => {
    const actions = makeActions();
    render(<Harness actions={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect apps first" }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(actions.dispatch).toHaveBeenLastCalledWith({ type: "apps.closed", connectedNames: [] });
    expect(screen.queryByText("Gmail connected")).not.toBeInTheDocument();
  });

  it("explains an empty repo list and asks for a repo link", () => {
    const events: OnboardingWidgetEvent[] = [{ type: "task.selected", taskId: "work-on-code", connectedServices: ["github"] }];
    render(<Harness actions={makeActions()} events={events} repos={[]} />);
    expect(screen.getByText("No repos found")).toBeInTheDocument();
    expect(screen.getByText("Paste a repo link below to work on it.")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Or paste a repo URL…")).toBeInTheDocument();
  });

  it("explains an empty app search and clears the search and filter", () => {
    render(<Harness actions={makeActions()} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect apps first" }));
    fireEvent.click(screen.getByRole("button", { name: "Dev" }));
    fireEvent.change(screen.getByLabelText("Search apps"), { target: { value: "zzz" } });
    expect(screen.getByText("No apps match")).toBeInTheDocument();
    expect(screen.getByText("Try another name or filter.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByLabelText("Search apps")).toHaveValue("");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Gmail")).toBeInTheDocument();
  });

  it("picks a repo from the list for Work on my code", () => {
    const events: OnboardingWidgetEvent[] = [{ type: "task.selected", taskId: "work-on-code", connectedServices: ["github"] }];
    const actions = makeActions();
    render(<Harness actions={actions} events={events} />);
    expect(screen.getByText("Which repo?")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Or paste a repo URL…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /portfolio/ }));
    expect(actions.dispatch).toHaveBeenCalledWith({ type: "answer.submitted", text: "portfolio", context: "https://github.com/sahar/portfolio" });
  });

  it("plays the screen transition when the step changes, not while a run updates in place", () => {
    const actions = makeActions();
    const { container, rerender } = render(<Harness actions={actions} />);
    const screenNode = () => container.querySelector(".mxo-screen");
    const tasks = screenNode();
    expect(tasks).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Research anything/ }));
    const question = screenNode();
    expect(question).not.toBe(tasks);

    fireEvent.click(screen.getByRole("button", { name: "AI agent pricing" }));
    const running = screenNode();
    expect(running).not.toBe(question);
    rerender(<Harness actions={actions} runView={{ status: "running", steps: [{ id: "s1", label: "Searching the web", state: "running" }] }} />);
    expect(screenNode()).toBe(running);
  });
});

describe("keeping the onboarding widget private", () => {
  it("keeps the card and the bubble out of session replay", () => {
    const card = render(<Harness actions={makeActions()} />);
    expect(card.container.querySelector(".mxo-root")).toHaveClass("ph-no-capture");
    card.unmount();

    const bubble = render(<Harness actions={makeActions()} initial={initialOnboardingWidgetState({ size: "bubble", firstTaskCompleted: false })} />);
    expect(bubble.container.querySelector(".mxo-root")).toHaveClass("ph-no-capture");
  });

  it("loads app logos without sending the page address", () => {
    const { container } = render(<Harness actions={makeActions()} events={[{ type: "apps.opened" }]} />);
    expect(container.querySelector('img[src="https://example.test/gcal.png"]')).toHaveAttribute("referrerpolicy", "no-referrer");
  });
});

describe("moving the onboarding widget", () => {
  const BUBBLE_STATE = initialOnboardingWidgetState({ size: "bubble", firstTaskCompleted: false });

  function drag(handle: Element, to: { x: number; y: number }, from = { x: 100, y: 100 }) {
    fireEvent.pointerDown(handle, { button: 0, clientX: from.x, clientY: from.y });
    fireEvent.pointerMove(handle, { buttons: 1, clientX: to.x, clientY: to.y });
    fireEvent.pointerUp(handle, { clientX: to.x, clientY: to.y });
  }

  it("drags the card by its header anywhere on screen and remembers where it was dropped", () => {
    const actions = makeActions();
    const { container } = render(<Harness actions={actions} />);
    const header = container.querySelector(".mxo-header")!;
    const root = container.querySelector(".mxo-root")!;

    fireEvent.pointerDown(header, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(header, { buttons: 1, clientX: 400, clientY: 300 });
    expect(root).toHaveAttribute("data-dragging");
    fireEvent.pointerUp(header, { clientX: 400, clientY: 300 });

    expect(root).not.toHaveAttribute("data-dragging");
    expect(actions.changePrefs).toHaveBeenCalledWith(expect.objectContaining({
      position: { x: "left", y: "top", dx: 300, dy: 200 },
    }));
    expect(screen.getByRole("region", { name: "Matrix" })).toBeInTheDocument();
  });

  it("stops following the pointer once the button is released outside the header", () => {
    const actions = makeActions();
    const { container } = render(<Harness actions={actions} />);
    const header = container.querySelector<HTMLElement>(".mxo-header")!;
    const root = container.querySelector(".mxo-root")!;
    const capture = vi.fn();
    header.setPointerCapture = capture;

    fireEvent.pointerDown(header, { button: 0, buttons: 1, pointerId: 1, clientX: 100, clientY: 100 });
    expect(capture).toHaveBeenCalledWith(1);

    fireEvent.pointerMove(header, { buttons: 0, pointerId: 1, clientX: 400, clientY: 300 });
    expect(root).not.toHaveAttribute("data-dragging");
    fireEvent.pointerMove(header, { buttons: 1, pointerId: 1, clientX: 500, clientY: 400 });
    expect(root).not.toHaveAttribute("data-dragging");
    expect(actions.changePrefs).not.toHaveBeenCalled();
  });

  it("tells the host its measured size so the support launcher can stay clear of it", () => {
    const observers: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(private readonly callback: () => void) {}
      observe() {
        observers.push(this.callback);
      }
      disconnect() {}
    });
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 392, 300));
    try {
      const onSizeChange = vi.fn();
      render(<Harness actions={makeActions()} onSizeChange={onSizeChange} />);
      act(() => observers.forEach((notify) => notify()));
      expect(onSizeChange).toHaveBeenLastCalledWith({ width: 392, height: 300 });
    } finally {
      rect.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("keeps the header buttons working instead of starting a drag from them", () => {
    const actions = makeActions();
    render(<Harness actions={actions} />);
    const more = screen.getByRole("button", { name: "More" });
    drag(more, { x: 400, y: 300 });
    expect(actions.changePrefs).not.toHaveBeenCalled();
    fireEvent.click(more);
    expect(screen.getByRole("menu", { name: "Matrix options" })).toBeInTheDocument();
  });

  it("opens the bubble on a click or a small wobble, but not right after dragging it", () => {
    const actions = makeActions();
    const { unmount } = render(<Harness actions={actions} initial={BUBBLE_STATE} />);
    const bubble = screen.getByRole("button", { name: /Open Matrix/ });
    drag(bubble, { x: 102, y: 101 });
    fireEvent.click(bubble);
    expect(actions.dispatch).toHaveBeenCalledWith({ type: "size.changed", size: "corner" });
    expect(actions.changePrefs).not.toHaveBeenCalled();
    unmount();

    const moved = makeActions();
    render(<Harness actions={moved} initial={BUBBLE_STATE} />);
    const dragged = screen.getByRole("button", { name: /Open Matrix/ });
    drag(dragged, { x: 700, y: 500 });
    fireEvent.click(dragged);
    expect(moved.dispatch).not.toHaveBeenCalledWith({ type: "size.changed", size: "corner" });
    expect(moved.changePrefs).toHaveBeenCalledWith(expect.objectContaining({
      position: { x: "right", y: "bottom", dx: 424, dy: 368 },
    }));
    fireEvent.click(dragged);
    expect(moved.dispatch).toHaveBeenCalledWith({ type: "size.changed", size: "corner" });
  });

  it("drops a drag that the browser cancels without moving the widget", () => {
    const actions = makeActions();
    const { container } = render(<Harness actions={actions} />);
    const header = container.querySelector(".mxo-header")!;
    fireEvent.pointerDown(header, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(header, { buttons: 1, clientX: 400, clientY: 300 });
    fireEvent.pointerCancel(header);
    expect(container.querySelector(".mxo-root")).not.toHaveAttribute("data-dragging");
    expect(actions.changePrefs).not.toHaveBeenCalled();
  });

  it("shows the widget at its saved spot", () => {
    const { container } = render(
      <Harness actions={makeActions()} prefs={{ keepInCorner: true, position: { x: "left", y: "top", dx: 120, dy: 90 }, showOnLogin: true }} />,
    );
    const root = container.querySelector<HTMLElement>(".mxo-root")!;
    expect(root.style.left).toBe("120px");
    expect(root.style.top).toBe("90px");
    expect(root.style.right).toBe("");
    expect(root.style.bottom).toBe("");
    expect(root).toHaveClass("mxo-root--left", "mxo-root--top");
  });

  it("moves to either bottom corner from the menu, and back to its corner after a free move", () => {
    const actions = makeActions();
    const prefs = { keepInCorner: true, position: { x: "right", y: "top", dx: 40, dy: 60 }, showOnLogin: true } as const;
    render(<Harness actions={actions} prefs={prefs} />);

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move back to the corner" }));
    expect(actions.changePrefs).toHaveBeenLastCalledWith({ ...prefs, position: DEFAULT_ONBOARDING_POSITION });

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to the left corner" }));
    expect(actions.changePrefs).toHaveBeenLastCalledWith({ ...prefs, position: { x: "left", y: "bottom", dx: 24, dy: 24 } });
  });

  it("offers only the other corner while the widget already sits in one", () => {
    render(<Harness actions={makeActions()} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: "Move to the left corner" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Move back to the corner" })).not.toBeInTheDocument();
  });
});
