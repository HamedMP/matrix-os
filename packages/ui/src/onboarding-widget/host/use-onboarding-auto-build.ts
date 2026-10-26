import type { OnboardingWidgetEvent, OnboardingWidgetState } from "@matrix-os/contracts";
import { useEffect, useRef } from "react";

type RunIdentity = { answer: string; title: string | undefined };

type AutoBuild =
  | { phase: "waiting" }
  /**
   * `requestId` and `run` (its prompt and title) are the build's run, known once the reducer has
   * started it. While the run waits for the computer, `computer.ready` retries it under a new
   * request ID; a run with the same prompt and title is still the build, anything else is not.
   */
  | { phase: "started"; requestId: number | null; run: RunIdentity | null; waitingForComputer: boolean }
  | { phase: "done" };

/**
 * Spec 635 (team feedback): the first app the owner picked in Get started starts building as
 * soon as they arrive and an AI can run it, then its chat opens so they can watch. Picking it
 * was the go-ahead. It starts only from the idle task list: if the owner picks something else
 * while it waits for an AI, it stays the widget's one-click task. Once per arrival: starting or
 * dropping it consumes `finishedNow`, so a remounted widget never starts it again.
 */
export function useOnboardingAutoBuild({ suggestion, finishedNow, consumeFinishedNow, aiReady, state, dispatch, openChat }: {
  suggestion: { title: string; prompt: string } | null;
  /** The owner finished Get started in this window just now. */
  finishedNow: boolean;
  consumeFinishedNow: () => void;
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
      consumeFinishedNow();
      return;
    }
    if (!aiReady) return;
    auto.current = { phase: "started", requestId: null, run: null, waitingForComputer: false };
    dispatch({ type: "build.requested", title: suggestion.title, prompt: suggestion.prompt });
    consumeFinishedNow();
  }, [aiReady, consumeFinishedNow, dispatch, finishedNow, idle, suggestion]);

  const runRequest = state.screen.kind === "run" ? state.screen.requestId : null;
  const runPhase = state.screen.kind === "run" ? state.screen.phase : null;
  const runAnswer = state.screen.kind === "run" ? state.screen.answer : null;
  const runTitle = state.screen.kind === "run" ? state.screen.title : undefined;
  const hasChat = state.chatId !== null;
  useEffect(() => {
    const current = auto.current;
    if (current.phase !== "started") return;
    const sameRun = current.run !== null && runAnswer === current.run.answer && runTitle === current.run.title;
    const retried = current.waitingForComputer && sameRun && runRequest !== null && runPhase === "starting";
    let requestId = current.requestId;
    let run = current.run;
    if (requestId === null || retried) {
      if (runRequest === null || runAnswer === null) return;
      requestId = runRequest;
      run = { answer: runAnswer, title: runTitle };
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
      auto.current = { phase: "started", requestId, run, waitingForComputer: runPhase === "waiting_computer" };
    }
  }, [hasChat, openChat, runAnswer, runPhase, runRequest, runTitle]);
}
