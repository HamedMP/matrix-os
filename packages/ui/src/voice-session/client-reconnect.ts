/**
 * Bounded reconnect loop for the voice session client. Owns the attempt
 * counter, the scheduled retry timer, and the server-hinted `retryAfterMs`
 * floor so the composition file stays declarative.
 *
 * Every reconnect goes through the authenticated REST route (tickets are
 * single-use); retryable failures reschedule with exponential backoff up to
 * the contract cap, non-retryable ones fail the session.
 */
import type { SafeVoiceError } from "@matrix-os/contracts/voice-session";
import {
  VoiceSessionApiError,
  voiceErrorForCode,
  type VoiceSessionApi,
  type VoiceSessionTransportGrant,
} from "./session-api.js";
import { CONNECTION_LOST_FATAL } from "./client-types.js";

const RECONNECT_BASE_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 10_000;

export interface VoiceReconnectLoopDeps {
  isDisposed(): boolean;
  /** Callers bump a generation on session start/dispose; stale loops retire silently. */
  generation(): number;
  session(): { sessionId: string; chatId: string } | null;
  api: Pick<VoiceSessionApi, "reconnect">;
  maxAttempts: number;
  setTimeoutFn(callback: () => void, ms: number): unknown;
  clearTimeoutFn(timer: unknown): void;
  setPhase(phase: "reconnecting"): void;
  failSession(error: SafeVoiceError): void;
  /** Hands a fresh transport grant to the caller for (re)connection. */
  onGrant(grant: VoiceSessionTransportGrant): void;
}

export interface VoiceReconnectLoop {
  /** Server hint from `transport.going_away`; floors the next backoff delay. */
  noteRetryAfter(ms: number): void;
  /** Current server-hinted floor, echoed back to the controller in `going_away`. */
  retryAfter(): number;
  /** Schedules a reconnect attempt, or fails when the attempt cap is reached. */
  schedule(): void;
  /** Runs a reconnect now; `resetAttempts` clears the backoff ladder. */
  perform(resetAttempts: boolean): Promise<void>;
  /** Successful resume clears the ladder for the next outage. */
  onResumed(): void;
  /** New session start: clears the ladder without touching the timer. */
  reset(): void;
  /** Cancels any pending timer (teardown/dispose paths). */
  cancel(): void;
}

export function createReconnectLoop(deps: VoiceReconnectLoopDeps): VoiceReconnectLoop {
  let attempts = 0;
  let retryAfterMs = 0;
  let timer: unknown;

  const cancel = () => {
    if (timer !== undefined) {
      deps.clearTimeoutFn(timer);
      timer = undefined;
    }
  };

  const schedule = () => {
    if (deps.isDisposed() || timer !== undefined) return;
    if (attempts >= deps.maxAttempts) {
      deps.failSession(CONNECTION_LOST_FATAL);
      return;
    }
    const delay = Math.min(
      Math.max(retryAfterMs, RECONNECT_BASE_DELAY_MS * 2 ** attempts),
      MAX_RECONNECT_DELAY_MS,
    );
    timer = deps.setTimeoutFn(() => {
      timer = undefined;
      void loop.perform(false);
    }, delay);
  };

  const loop: VoiceReconnectLoop = {
    noteRetryAfter(ms) {
      retryAfterMs = Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RECONNECT_DELAY_MS) : 0;
    },
    retryAfter() {
      return retryAfterMs;
    },
    schedule,
    async perform(resetAttempts) {
      const session = deps.session();
      if (session === null || deps.isDisposed()) return;
      if (resetAttempts) attempts = 0;
      cancel();
      attempts += 1;
      const gen = deps.generation();
      deps.setPhase("reconnecting");
      let grant;
      try {
        grant = await deps.api.reconnect(session.chatId, session.sessionId);
      } catch (reconnectError: unknown) {
        if (deps.isDisposed() || deps.generation() !== gen) return;
        const safe = reconnectError instanceof VoiceSessionApiError
          ? reconnectError.safeError
          : voiceErrorForCode("connection_failed");
        if (safe.retryable && attempts < deps.maxAttempts) {
          schedule();
          return;
        }
        deps.failSession(safe.retryable ? safe : CONNECTION_LOST_FATAL);
        return;
      }
      if (deps.isDisposed() || deps.generation() !== gen) return;
      deps.onGrant(grant.transport);
    },
    onResumed() {
      attempts = 0;
      retryAfterMs = 0;
    },
    reset() {
      attempts = 0;
      retryAfterMs = 0;
    },
    cancel,
  };
  return loop;
}
