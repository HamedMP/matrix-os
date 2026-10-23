// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialOnboardingWidgetState, reduceOnboardingWidget } from "../../packages/contracts/src/index.js";
import { useOnboardingAutoBuild } from "../../packages/ui/src/onboarding-widget/host/use-onboarding-auto-build.js";

afterEach(cleanup);

const suggestion = { title: "Habit tracker", prompt: "[BUILD] Build an app for my Matrix computer: Track my habits." };

function useHarness(props: { finishedNow: boolean; aiReady: boolean; openChat: () => void; suggestion?: typeof suggestion | null }) {
  const [state, dispatch] = useReducer(reduceOnboardingWidget, { size: "corner", firstTaskCompleted: false }, initialOnboardingWidgetState);
  useOnboardingAutoBuild({ suggestion: props.suggestion === undefined ? suggestion : props.suggestion, finishedNow: props.finishedNow, aiReady: props.aiReady, state, dispatch, openChat: props.openChat });
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
});
