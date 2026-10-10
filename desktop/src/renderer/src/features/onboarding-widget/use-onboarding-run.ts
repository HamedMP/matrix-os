import {
  buildOnboardingPrompt,
  chatMessageVersionUrl,
  chatReadStateVersionUrl,
  deriveOnboardingRunView,
  onboardingTask,
  type OnboardingRunView,
  type OnboardingWidgetEvent,
  type OnboardingWidgetState,
} from "@matrix-os/contracts";
import { useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api";
import { createCanonicalChatEventSource, type CanonicalChatClient } from "../../lib/canonical-chat-client";
import type { CanonicalComposerSelection } from "../chat/canonical-composer-state";
import { admitOnboardingTurn, isComputerStartingError } from "./onboarding-widget-runner";

export const COMPUTER_RETRY_DELAYS_MS = [3_000, 5_000, 8_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000];
const DETAIL_POLL_MS = 5_000;
const DETAIL_TIMEOUT_MS = 15 * 60 * 1000;

interface RunDeps {
  api: ApiClient | null;
  client: CanonicalChatClient | null;
  selection: CanonicalComposerSelection | null;
  /** The provider catalog is still loading, so a missing selection is not final yet. */
  selectionPending: boolean;
}

/** Executes the run the reducer asked for and projects its canonical Chat detail back into the widget. */
export function useOnboardingRun(state: OnboardingWidgetState, dispatch: (event: OnboardingWidgetEvent) => void, deps: RunDeps): OnboardingRunView | null {
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
    const { client, selection, selectionPending } = depsRef.current;
    if (!client || !selection) {
      if ((!client || selectionPending) && computerAttempts.current < COMPUTER_RETRY_DELAYS_MS.length) {
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
    void admitOnboardingTurn({ client, chatId: chatIdRef.current, prompt, selection }).then(
      (admitted) => {
        computerAttempts.current = 0;
        dispatch({ type: "run.admitted", requestId, chatId: admitted.chatId, runId: admitted.runId });
      },
      (error: unknown) => {
        console.warn("[onboarding-widget] turn admission failed:", error instanceof Error ? error.name : typeof error);
        if (isComputerStartingError(error) && computerAttempts.current < COMPUTER_RETRY_DELAYS_MS.length) {
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
    const { api, client } = depsRef.current;
    if (!runId || !chatId || !api || !client) return;
    let disposed = false;
    let inFlight = false;
    const startedAt = Date.now();
    const refresh = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const detail = await client.getDetail(chatId);
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
    const eventSource = createCanonicalChatEventSource({
      openStream({ cursor, signal }) {
        return api.openStream(chatReadStateVersionUrl(chatMessageVersionUrl("/api/chats/events")), {
          accept: "text/event-stream", signal, timeoutMs: 5 * 60 * 1000,
          headers: { "x-matrix-chat-protocol": "2", ...(cursor === undefined ? {} : { "last-event-id": String(cursor) }) },
        });
      },
    });
    const subscription = eventSource.subscribe((event) => {
      if (event.type === "chat.full_refresh" || event.chatId === chatId) void refresh();
    });
    void eventSource.start();
    void refresh();
    const poll = setInterval(() => void refresh(), DETAIL_POLL_MS);
    return () => {
      disposed = true;
      clearInterval(poll);
      subscription.dispose();
      eventSource.dispose();
    };
  }, [chatId, dispatch, failedStepLabel, runId]);

  return screen ? runView : null;
}
