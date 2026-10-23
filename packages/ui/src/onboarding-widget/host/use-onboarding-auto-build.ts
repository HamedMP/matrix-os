import { onboardingRunInFlight, type OnboardingWidgetEvent, type OnboardingWidgetState } from "@matrix-os/contracts";
import { useEffect, useRef } from "react";

/**
 * Spec 635 (team feedback): the first app the owner picked in Get started starts building as
 * soon as they arrive and an AI can run it, then its chat opens so they can watch. Picking it
 * was the go-ahead. Without a ready AI it stays a one-click task in the widget. Once per arrival.
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
  const phase = useRef<"waiting" | "started" | "opened">("waiting");
  const busy = onboardingRunInFlight(state);
  useEffect(() => {
    if (phase.current !== "waiting" || !finishedNow || !suggestion || !aiReady || busy) return;
    phase.current = "started";
    dispatch({ type: "build.requested", title: suggestion.title, prompt: suggestion.prompt });
  }, [aiReady, busy, dispatch, finishedNow, suggestion]);

  const admitted = state.screen.kind === "run" && state.screen.phase === "running" && state.chatId !== null;
  useEffect(() => {
    if (phase.current !== "started" || !admitted) return;
    phase.current = "opened";
    openChat();
  }, [admitted, openChat]);
}
