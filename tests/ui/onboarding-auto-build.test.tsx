// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import React, { useCallback, useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialOnboardingWidgetState, reduceOnboardingWidget, type OnboardingWidgetEvent } from "../../packages/contracts/src/index.js";
import {
  GetStartedAnswersProvider,
  useConsumeGetStartedFinishedNow,
  useGetStartedFinishedNow,
  usePublishGetStartedAnswers,
} from "../../packages/ui/src/get-started/answers-context.js";
import { useOnboardingAutoBuild } from "../../packages/ui/src/onboarding-widget/host/use-onboarding-auto-build.js";

afterEach(cleanup);

const suggestion = { title: "Habit tracker", prompt: "[BUILD] Build an app for my Matrix computer: Track my habits." };

function useHarness(props: { finishedNow: boolean; aiReady: boolean; openChat: () => void; suggestion?: typeof suggestion | null }) {
  const [state, dispatch] = useReducer(reduceOnboardingWidget, { size: "corner", firstTaskCompleted: false }, initialOnboardingWidgetState);
  useOnboardingAutoBuild({
    suggestion: props.suggestion === undefined ? suggestion : props.suggestion,
    finishedNow: props.finishedNow,
    consumeFinishedNow: () => {},
    aiReady: props.aiReady,
    state,
    dispatch,
    openChat: props.openChat,
  });
  return { state, dispatch };
}

function admit(result: { current: ReturnType<typeof useHarness> }) {
  const screen = result.current.state.screen;
  if (screen.kind !== "run") throw new Error("no run");
  act(() => result.current.dispatch({ type: "run.admitted", requestId: screen.requestId, chatId: "chat_build", runId: "run_1" }));
}

describe("onboarding auto build", () => {
  it("starts the app picked in Get started as soon as an AI is ready, then opens its chat once", () => {
    const openChat = vi.fn();
    const { result, rerender } = renderHook((props: { aiReady: boolean }) => useHarness({ finishedNow: true, aiReady: props.aiReady, openChat }), { initialProps: { aiReady: false } });
    expect(result.current.state.screen.kind).toBe("tasks");
    rerender({ aiReady: true });
    expect(result.current.state.screen).toMatchObject({ kind: "run", title: "Build: Habit tracker", phase: "starting" });
    expect(openChat).not.toHaveBeenCalled();
    admit(result);
    expect(openChat).toHaveBeenCalledOnce();
    rerender({ aiReady: true });
    expect(openChat).toHaveBeenCalledOnce();
  });

  it("leaves the build as a task when setup finished earlier, or nothing was picked", () => {
    const openChat = vi.fn();
    const earlier = renderHook(() => useHarness({ finishedNow: false, aiReady: true, openChat }));
    expect(earlier.result.current.state.screen.kind).toBe("tasks");
    const none = renderHook(() => useHarness({ finishedNow: true, aiReady: true, openChat, suggestion: null }));
    expect(none.result.current.state.screen.kind).toBe("tasks");
    expect(openChat).not.toHaveBeenCalled();
  });

  it("never replaces a task the owner started while the build waited for an AI", () => {
    const openChat = vi.fn();
    const { result, rerender } = renderHook((props: { aiReady: boolean }) => useHarness({ finishedNow: true, aiReady: props.aiReady, openChat }), { initialProps: { aiReady: false } });
    act(() => result.current.dispatch({ type: "task.selected", taskId: "research", connectedServices: [] }));
    const picked = result.current.state.screen;
    expect(picked.kind).not.toBe("tasks");
    rerender({ aiReady: true });
    expect(result.current.state.screen).toEqual(picked);
    // Back on the task list later, the build stays a one-click task.
    act(() => result.current.dispatch({ type: "tasks.requested" }));
    rerender({ aiReady: true });
    expect(result.current.state.screen.kind).toBe("tasks");
  });

  it("opens only the automatic build's chat, never a later task's", () => {
    const openChat = vi.fn();
    const { result } = renderHook(() => useHarness({ finishedNow: true, aiReady: true, openChat }));
    expect(result.current.state.screen).toMatchObject({ kind: "run", phase: "starting" });
    act(() => result.current.dispatch({ type: "run.failedToStart" }));
    act(() => result.current.dispatch({ type: "tasks.requested" }));
    act(() => result.current.dispatch({ type: "build.requested", title: "Recipe box", prompt: "Build a recipe box." }));
    admit(result);
    expect(openChat).not.toHaveBeenCalled();
  });

  it("still opens Chat when the build is retried after the computer was briefly unreachable", () => {
    const openChat = vi.fn();
    const { result } = renderHook(() => useHarness({ finishedNow: true, aiReady: true, openChat }));
    act(() => result.current.dispatch({ type: "computer.waiting" }));
    expect(result.current.state.screen).toMatchObject({ kind: "run", phase: "waiting_computer" });
    act(() => result.current.dispatch({ type: "computer.ready" }));
    expect(result.current.state.screen).toMatchObject({ kind: "run", phase: "starting" });
    admit(result);
    expect(openChat).toHaveBeenCalledOnce();
  });

  it("drops the handoff when the owner leaves a build that waits for the computer", () => {
    const openChat = vi.fn();
    const { result } = renderHook(() => useHarness({ finishedNow: true, aiReady: true, openChat }));
    act(() => result.current.dispatch({ type: "computer.waiting" }));
    act(() => result.current.dispatch({ type: "tasks.requested" }));
    act(() => result.current.dispatch({ type: "build.requested", title: "Recipe box", prompt: "Build a recipe box." }));
    admit(result);
    expect(openChat).not.toHaveBeenCalled();
  });

  it("never opens Chat for a different message sent while the build waits for the computer", () => {
    const openChat = vi.fn();
    const { result } = renderHook(() => useHarness({ finishedNow: true, aiReady: true, openChat }));
    act(() => result.current.dispatch({ type: "computer.waiting" }));
    act(() => result.current.dispatch({ type: "freeform.submitted", text: "Summarize my week instead." }));
    expect(result.current.state.screen).toMatchObject({ kind: "run", phase: "starting", answer: "Summarize my week instead." });
    admit(result);
    expect(openChat).not.toHaveBeenCalled();
  });
});

describe("onboarding auto build across widget remounts", () => {
  /** Like the Get started gate right after the owner finished: published once, never again. */
  function FinishedJustNow() {
    usePublishGetStartedAnswers(null, true, true);
    return null;
  }

  function Widget({ aiReady, builds }: { aiReady: boolean; builds: string[] }) {
    const [state, reduce] = useReducer(reduceOnboardingWidget, { size: "corner", firstTaskCompleted: false }, initialOnboardingWidgetState);
    const dispatch = useCallback((event: OnboardingWidgetEvent) => {
      if (event.type === "build.requested") builds.push(event.title);
      reduce(event);
    }, [builds]);
    useOnboardingAutoBuild({
      suggestion,
      finishedNow: useGetStartedFinishedNow(),
      consumeFinishedNow: useConsumeGetStartedFinishedNow(),
      aiReady,
      state,
      dispatch,
      openChat: () => {},
    });
    return null;
  }

  function Desktop({ widget, aiReady, builds }: { widget: number; aiReady: boolean; builds: string[] }) {
    return (
      <GetStartedAnswersProvider scope="owner">
        <FinishedJustNow />
        <Widget key={widget} aiReady={aiReady} builds={builds} />
      </GetStartedAnswersProvider>
    );
  }

  it("starts the picked app once per arrival, even when the widget remounts", () => {
    const builds: string[] = [];
    const view = render(<Desktop widget={1} aiReady={false} builds={builds} />);
    // Remounted while it waits for an AI, the build is still the next thing to start.
    view.rerender(<Desktop widget={2} aiReady={false} builds={builds} />);
    expect(builds).toEqual([]);
    view.rerender(<Desktop widget={2} aiReady builds={builds} />);
    expect(builds).toEqual(["Habit tracker"]);
    // Remounted after it started, the widget never starts it a second time.
    view.rerender(<Desktop widget={3} aiReady builds={builds} />);
    expect(builds).toEqual(["Habit tracker"]);
  });
});
