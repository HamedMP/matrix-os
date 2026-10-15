// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  initialOnboardingWidgetState,
  reduceOnboardingWidget,
  type OnboardingWidgetEvent,
  type OnboardingWidgetState,
} from "../../packages/contracts/src/index.js";
import { useOnboardingChatHandoff } from "../../packages/ui/src/onboarding-widget/host/index.js";

function run(state: OnboardingWidgetState, ...events: OnboardingWidgetEvent[]): OnboardingWidgetState {
  return events.reduce(reduceOnboardingWidget, state);
}

function requestIdOf(state: OnboardingWidgetState): number {
  return state.screen.kind === "run" ? state.screen.requestId : -1;
}

describe("useOnboardingChatHandoff", () => {
  it("opens the main Chat once for each run the chat accepts", () => {
    const handOff = vi.fn();
    const started = run(
      initialOnboardingWidgetState({ size: "corner", firstTaskCompleted: false }),
      { type: "task.selected", taskId: "plan-week", connectedServices: ["google_calendar"] },
    );
    const admitted = run(started, { type: "run.admitted", requestId: requestIdOf(started), chatId: "chat_week", runId: "run_1" });
    const done = run(admitted, { type: "run.settled", runId: "run_1", outcome: "completed" });
    const next = run(done, { type: "freeform.submitted", text: "Summarize today" });
    const nextAdmitted = run(next, { type: "run.admitted", requestId: requestIdOf(next), chatId: "chat_today", runId: "run_2" });

    const { rerender } = renderHook(({ state }) => useOnboardingChatHandoff(state, handOff), { initialProps: { state: started } });
    expect(handOff).not.toHaveBeenCalled();

    rerender({ state: admitted });
    expect(handOff).toHaveBeenCalledTimes(1);
    rerender({ state: { ...admitted } });
    rerender({ state: done });
    expect(handOff).toHaveBeenCalledTimes(1);

    rerender({ state: next });
    expect(handOff).toHaveBeenCalledTimes(1);
    rerender({ state: nextAdmitted });
    expect(handOff).toHaveBeenCalledTimes(2);
  });
});
