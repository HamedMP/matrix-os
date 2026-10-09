// @vitest-environment jsdom
import React, { useReducer } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  initialOnboardingWidgetState,
  reduceOnboardingWidget,
  type OnboardingRunView,
  type OnboardingWidgetEvent,
  type OnboardingWidgetState,
} from "../../packages/contracts/src/index.js";
import { OnboardingWidget } from "../../packages/ui/src/onboarding-widget/index.js";
import type { OnboardingWidgetActions, OnboardingWidgetApp } from "../../packages/ui/src/onboarding-widget/index.js";

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
    changePrefs: vi.fn(),
  };
}

function Harness({ actions, initial, runView = null, creditsExhausted = false, events = [] }: {
  actions: OnboardingWidgetActions;
  initial?: OnboardingWidgetState;
  runView?: OnboardingRunView | null;
  creditsExhausted?: boolean;
  events?: OnboardingWidgetEvent[];
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
      apps={APPS}
      repos={[{ name: "portfolio", url: "https://github.com/sahar/portfolio", updatedLabel: "2h ago" }]}
      runView={runView}
      connectedProviders={[]}
      creditsExhausted={creditsExhausted}
      prefs={{ keepInCorner: true, side: "right", showOnLogin: true }}
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

  it("shows the result, then exactly one follow-up", () => {
    const actions = makeActions();
    const events: OnboardingWidgetEvent[] = [
      { type: "task.selected", taskId: "research", connectedServices: [] },
      { type: "answer.submitted", text: "AI agent pricing" },
      { type: "run.admitted", requestId: 1, chatId: "chat_1", runId: "run_1" },
      { type: "run.settled", runId: "run_1", outcome: "completed" },
    ];
    render(<Harness actions={actions} events={events} runView={{ status: "completed", steps: [{ id: "t1", label: "Searched 24 sources", state: "done" }], resultSummary: "9 sources" }} />);
    expect(screen.getByText("Your brief is ready.")).toBeInTheDocument();
    expect(screen.getByText("Searched 24 sources")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
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

  it("lists apps with Connected chips and confirms on Done", () => {
    render(<Harness actions={makeActions()} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect apps first" }));
    expect(screen.getByText("Connect the apps you use.")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search apps"), { target: { value: "git" } });
    expect(screen.queryByText("Gmail")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByText("Gmail connected")).toBeInTheDocument();
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
});
