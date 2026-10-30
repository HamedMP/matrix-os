// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialOnboardingWidgetState, type OnboardingWidgetState } from "@matrix-os/contracts";
import {
  onboardingWidgetStatus,
  requestOnboardingTask,
  requestOnboardingWidgetShow,
  useOnboardingTaskRequests,
  useOnboardingWidgetStatus,
  usePublishOnboardingWidgetStatus,
  type OnboardingWidgetStatus,
} from "../../packages/ui/src/onboarding-widget/task-requests";

afterEach(() => cleanup());

function Listener({ onTask, onShow = () => undefined }: { onTask(taskId: string): void; onShow?(): void }) {
  useOnboardingTaskRequests(onTask, onShow);
  return null;
}

function Publisher({ status }: { status: OnboardingWidgetStatus }) {
  usePublishOnboardingWidgetStatus(status);
  return null;
}

function Reader() {
  const status = useOnboardingWidgetStatus();
  return <span data-testid="status">{status ? `${status.open ? "open" : "closed"}:${status.activity.kind}:${"title" in status.activity ? status.activity.title : ""}` : "none"}</span>;
}

function widgetState(overrides: Partial<OnboardingWidgetState>): OnboardingWidgetState {
  return { ...initialOnboardingWidgetState({ size: "corner", aiChoice: "matrix", chatId: null, firstTaskCompleted: false, pendingRun: null } as never), ...overrides };
}

describe("onboarding task requests", () => {
  it("reports that nobody handled a request when no widget is mounted", () => {
    expect(requestOnboardingTask("research")).toBe(false);
  });

  it("hands a starter task to the mounted widget", () => {
    const onTask = vi.fn();
    render(<Listener onTask={onTask} />);
    expect(requestOnboardingTask("plan-week")).toBe(true);
    expect(onTask).toHaveBeenCalledWith("plan-week");
  });

  it("delivers each request to the most recent widget only", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(<><Listener onTask={first} /><Listener onTask={second} /></>);
    requestOnboardingTask("build-website");
    expect(second).toHaveBeenCalledWith("build-website");
    expect(first).not.toHaveBeenCalled();
  });

  it("stops delivering once the widget unmounts", () => {
    const onTask = vi.fn();
    const { unmount } = render(<Listener onTask={onTask} />);
    unmount();
    expect(requestOnboardingTask("work-on-code")).toBe(false);
    expect(onTask).not.toHaveBeenCalled();
  });

  it("asks the mounted widget to show itself, and reports when none is mounted", () => {
    expect(requestOnboardingWidgetShow()).toBe(false);
    const onShow = vi.fn();
    render(<Listener onTask={vi.fn()} onShow={onShow} />);
    expect(requestOnboardingWidgetShow()).toBe(true);
    expect(onShow).toHaveBeenCalledTimes(1);
  });
});

describe("onboarding widget status", () => {
  it("describes what the widget is doing, by its starter task's label", () => {
    expect(onboardingWidgetStatus(widgetState({ size: "corner", screen: { kind: "tasks" } })))
      .toEqual({ open: true, activity: { kind: "choosing" } });
    expect(onboardingWidgetStatus(widgetState({ size: "bubble", screen: { kind: "question", taskId: "plan-week" } })))
      .toEqual({ open: false, activity: { kind: "setup", title: "Plan my week" } });
    expect(onboardingWidgetStatus(widgetState({ screen: { kind: "repo" } })).activity)
      .toEqual({ kind: "setup", title: "Work on my code" });
    const run = { kind: "run" as const, taskId: "research" as const, answer: "AI agent pricing", appConnected: false, simpler: false, requestId: 1 };
    expect(onboardingWidgetStatus(widgetState({ screen: { ...run, phase: "running" } })).activity)
      .toEqual({ kind: "running", title: "Research anything" });
    expect(onboardingWidgetStatus(widgetState({ screen: { ...run, phase: "waiting_computer" } })).activity.kind).toBe("running");
    expect(onboardingWidgetStatus(widgetState({ screen: { ...run, phase: "done", title: "Lisbon trip" } })).activity)
      .toEqual({ kind: "done", title: "Lisbon trip" });
    expect(onboardingWidgetStatus(widgetState({ screen: { ...run, taskId: "custom", answer: "Draft my investor update", phase: "failed" } })).activity)
      .toEqual({ kind: "failed", title: "Draft my investor update" });
  });

  it("shares the newest widget's status until it unmounts", () => {
    render(<Reader />);
    expect(screen.getByTestId("status").textContent).toBe("none");
    const view = render(<Publisher status={{ open: true, activity: { kind: "choosing" } }} />);
    expect(screen.getByTestId("status").textContent).toBe("open:choosing:");
    act(() => view.rerender(<Publisher status={{ open: false, activity: { kind: "running", title: "Plan my week" } }} />));
    expect(screen.getByTestId("status").textContent).toBe("closed:running:Plan my week");
    act(() => view.unmount());
    expect(screen.getByTestId("status").textContent).toBe("none");
  });
});
