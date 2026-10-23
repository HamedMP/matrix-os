import type { OnboardingWidgetEvent, OnboardingWidgetState } from "@matrix-os/contracts";
import { useEffect, useRef } from "react";

type AutoBuild =
  | { phase: "waiting" }
  /**
   * `requestId` is the build's run, known once the reducer has started it. While the run waits
   * for the computer, `computer.ready` retries it under a new request ID; that is still the build.
   */
  | { phase: "started"; requestId: number | null; waitingForComputer: boolean }
  | { phase: "done" };

/**
 * Spec 635 (team feedback): the first app the owner picked in Get started starts building as
 * soon as they arrive and an AI can run it, then its chat opens so they can watch. Picking it
 * was the go-ahead. It starts only from the idle task list: if the owner picks something else
 * while it waits for an AI, it stays the widget's one-click task. Once per arrival.
 */
export function useOnboardingAutoBuild({ suggestion, finishedNow, aiReady, state, dispatch, openChat }: {
  suggestion: { title: string; prompt: string } | null;
  /** The owner finished Get started in this window just now. */
  finishedNow: boolean;
  aiReady: boolean;
  state: OnboardingWidgetState;
  dispatch: (event: OnboardingWidgetEvent) => void;
  openChat: () => void;
}): void {
  const auto = useRef<AutoBuild>({ phase: "waiting" });
  const idle = state.screen.kind === "tasks";
  useEffect(() => {
    if (auto.current.phase !== "waiting" || !finishedNow || !suggestion) return;
    if (!idle) {
      auto.current = { phase: "done" };
      return;
    }
    if (!aiReady) return;
    auto.current = { phase: "started", requestId: null, waitingForComputer: false };
    dispatch({ type: "build.requested", title: suggestion.title, prompt: suggestion.prompt });
  }, [aiReady, dispatch, finishedNow, idle, suggestion]);

  const runRequest = state.screen.kind === "run" ? state.screen.requestId : null;
  const runPhase = state.screen.kind === "run" ? state.screen.phase : null;
  const hasChat = state.chatId !== null;
  useEffect(() => {
    const current = auto.current;
    if (current.phase !== "started") return;
    const retried = current.waitingForComputer && runRequest !== null && runPhase === "starting";
    let requestId = current.requestId;
    if (requestId === null || retried) {
      if (runRequest === null) return;
      requestId = runRequest;
    } else if (runRequest !== requestId) {
      // The build was left or replaced; a later task never opens Chat on its behalf.
      auto.current = { phase: "done" };
      return;
    }
    if (runPhase === "failed") {
      auto.current = { phase: "done" };
    } else if (runPhase === "running" && hasChat) {
      auto.current = { phase: "done" };
      openChat();
    } else {
      auto.current = { phase: "started", requestId, waitingForComputer: runPhase === "waiting_computer" };
    }
  }, [hasChat, openChat, runPhase, runRequest]);
}
