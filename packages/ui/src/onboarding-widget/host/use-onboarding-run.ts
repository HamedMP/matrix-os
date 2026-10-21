import {
  buildOnboardingPrompt,
  deriveOnboardingRunView,
  onboardingChatTitle,
  onboardingTask,
  type OnboardingRunView,
  type OnboardingWidgetEvent,
  type OnboardingWidgetState,
} from "@matrix-os/contracts";
import { useEffect, useRef, useState } from "react";
import type { CanonicalComposerSelection } from "../../canonical-composer-selection.js";
import {
  admitOnboardingTurn,
  onboardingAdmissionRequestIds,
  type OnboardingAdmissionRequestIds,
  type OnboardingChatPort,
} from "./chat-port.js";

export const COMPUTER_RETRY_DELAYS_MS = [3_000, 5_000, 8_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000];
const DETAIL_POLL_MS = 5_000;
const OLDER_PAGES_TO_CHECK = 10;

export interface OnboardingRunDeps {
  port: OnboardingChatPort | null;
  selection: CanonicalComposerSelection | null;
  /** The provider catalog is still loading, so a missing selection is not final yet. */
  selectionPending: boolean;
  /** Told which provider instance the watched run uses, so a follow-up can name the AI its chat stays on. */
  onRunInstance?: (instanceId: string | null) => void;
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
  /** Held while admissions of one prompt keep timing out; cleared once the server answers. */
  const pendingAdmission = useRef<{ prompt: string; requestIds: OnboardingAdmissionRequestIds } | null>(null);
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
    const pending = pendingAdmission.current?.prompt === prompt
      ? pendingAdmission.current
      : { prompt, requestIds: onboardingAdmissionRequestIds() };
    pendingAdmission.current = pending;
    void admitOnboardingTurn({ port, chatId: chatIdRef.current, title: onboardingChatTitle(screen), prompt, selection, requestIds: pending.requestIds }).then(
      (admitted) => {
        computerAttempts.current = 0;
        pendingAdmission.current = null;
        dispatch({ type: "run.admitted", requestId, chatId: admitted.chatId, runId: admitted.runId });
      },
      (error: unknown) => {
        console.warn("[onboarding-widget] turn admission failed:", error instanceof Error ? error.name : typeof error);
        if (port.isComputerStarting(error) && computerAttempts.current < COMPUTER_RETRY_DELAYS_MS.length) {
          dispatch({ type: "computer.waiting" });
          return;
        }
        computerAttempts.current = 0;
        pendingAdmission.current = null;
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
    const refresh = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        let detail = await port.detail(chatId);
        if (disposed) return;
        // Detail holds only the newest page; a chat that kept going elsewhere can push this run onto an older one.
        let cursor = detail.nextCursor;
        for (let page = 0; cursor && page < OLDER_PAGES_TO_CHECK && !detail.runs.some((run) => run.id === runId); page += 1) {
          detail = await port.detail(chatId, cursor);
          if (disposed) return;
          cursor = detail.nextCursor;
        }
        depsRef.current.onRunInstance?.(detail.runs.find((run) => run.id === runId)?.instanceId ?? null);
        const view = deriveOnboardingRunView(detail, runId, failedStepLabel ? { failedStepLabel } : {});
        setRunView(view);
        if (view.status === "completed" || view.status === "failed") {
          dispatch({ type: "run.settled", runId, outcome: view.status });
        } else if (!detail.runs.some((run) => run.id === runId)) {
          // Admission returns only after the run is stored, so a run on no page of the chat is gone.
          dispatch({ type: "run.settled", runId, outcome: "failed" });
        }
      } catch (error: unknown) {
        if (disposed) return;
        if (port.isNotFound(error)) {
          dispatch({ type: "chat.missing", chatId });
          return;
        }
        console.warn("[onboarding-widget] detail refresh failed:", error instanceof Error ? error.name : typeof error);
      } finally {
        inFlight = false;
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
