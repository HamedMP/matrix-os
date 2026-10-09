import {
  buildOnboardingPrompt,
  deriveOnboardingRunView,
  onboardingTask,
  type OnboardingRunView,
  type OnboardingWidgetEvent,
  type OnboardingWidgetState,
} from "@matrix-os/contracts";
import { useEffect, useRef, useState } from "react";
import type { CanonicalComposerSelection } from "../../canonical-composer-selection.js";
import { admitOnboardingTurn, type OnboardingChatPort } from "./chat-port.js";

export const COMPUTER_RETRY_DELAYS_MS = [3_000, 5_000, 8_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000];
const DETAIL_POLL_MS = 5_000;
const DETAIL_TIMEOUT_MS = 15 * 60 * 1000;

export interface OnboardingRunDeps {
  port: OnboardingChatPort | null;
  selection: CanonicalComposerSelection | null;
  /** The provider catalog is still loading, so a missing selection is not final yet. */
  selectionPending: boolean;
}

/** Executes the run the reducer asked for and projects its canonical Chat detail back into the widget. */
export function useOnboardingRun(
  state: OnboardingWidgetState,
  dispatch: (event: OnboardingWidgetEvent) => void,
  deps: OnboardingRunDeps,
): OnboardingRunView | null {
  const [runView, setRunView] = useState<OnboardingRunView | null>(null);
  const handledRequest = useRef(0);
  const computerAttempts = useRef(0);
  const depsRef = useRef(deps);
  const chatIdRef = useRef(state.chatId);
  useEffect(() => {
    depsRef.current = deps;
    chatIdRef.current = state.chatId;
  });

  const screen = state.screen.kind === "run" ? state.screen : null;
  const requestId = screen?.phase === "starting" ? screen.requestId : 0;
  const waiting = screen?.phase === "waiting_computer";

  useEffect(() => {
    if (!screen || requestId === 0 || handledRequest.current === requestId) return;
    handledRequest.current = requestId;
    setRunView(null);
    const { port, selection, selectionPending } = depsRef.current;
    if (!port || !selection) {
      if ((!port || selectionPending) && computerAttempts.current < COMPUTER_RETRY_DELAYS_MS.length) {
        dispatch({ type: "computer.waiting" });
        return;
      }
      computerAttempts.current = 0;
      dispatch({ type: "run.failedToStart" });
      return;
    }
    const prompt = buildOnboardingPrompt({
      taskId: screen.taskId,
      answer: screen.answer,
      appConnected: screen.appConnected,
      simpler: screen.simpler,
      ...(screen.context ? { context: screen.context } : {}),
    });
    void admitOnboardingTurn({ port, chatId: chatIdRef.current, prompt, selection }).then(
      (admitted) => {
        computerAttempts.current = 0;
        dispatch({ type: "run.admitted", requestId, chatId: admitted.chatId, runId: admitted.runId });
      },
      (error: unknown) => {
        console.warn("[onboarding-widget] turn admission failed:", error instanceof Error ? error.name : typeof error);
        if (port.isComputerStarting(error) && computerAttempts.current < COMPUTER_RETRY_DELAYS_MS.length) {
          dispatch({ type: "computer.waiting" });
          return;
        }
        computerAttempts.current = 0;
        dispatch({ type: "run.failedToStart" });
      },
    );
  }, [dispatch, requestId, screen]);

  useEffect(() => {
    if (!waiting) return;
    const delay = COMPUTER_RETRY_DELAYS_MS[computerAttempts.current] ?? COMPUTER_RETRY_DELAYS_MS.at(-1)!;
    computerAttempts.current += 1;
    const timer = setTimeout(() => dispatch({ type: "computer.ready" }), delay);
    return () => clearTimeout(timer);
  }, [dispatch, waiting]);

  const runId = screen?.phase === "running" ? screen.runId ?? null : null;
  const chatId = state.chatId;
  const failedStepLabel = screen ? onboardingTask(screen.taskId)?.failedStep : undefined;

  useEffect(() => {
    const { port } = depsRef.current;
    if (!runId || !chatId || !port) return;
    let disposed = false;
    let inFlight = false;
    const startedAt = Date.now();
    const refresh = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const detail = await port.detail(chatId);
        if (disposed) return;
        const view = deriveOnboardingRunView(detail, runId, failedStepLabel ? { failedStepLabel } : {});
        setRunView(view);
        if (view.status === "completed" || view.status === "failed") {
          dispatch({ type: "run.settled", runId, outcome: view.status });
        }
      } catch (error: unknown) {
        console.warn("[onboarding-widget] detail refresh failed:", error instanceof Error ? error.name : typeof error);
      } finally {
        inFlight = false;
      }
      if (!disposed && Date.now() - startedAt > DETAIL_TIMEOUT_MS) {
        dispatch({ type: "run.settled", runId, outcome: "failed" });
      }
    };
    const stopWatching = port.watch(chatId, () => void refresh());
    void refresh();
    const poll = setInterval(() => void refresh(), DETAIL_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(poll);
      stopWatching();
    };
  }, [chatId, dispatch, failedStepLabel, runId]);

  return screen ? runView : null;
}
