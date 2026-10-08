/**
 * Bounded async retry machinery for the voice session client: the reconnect
 * loop (attempt counter, scheduled retry timer, server-hinted `retryAfterMs`
 * floor) and the remote-session cleanup queue (deduped, bounded DELETE
 * retries) so the composition file stays declarative.
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
  /** Single-flight latch: overlapping performs join one REST reconnect. */
  let inFlight: Promise<void> | null = null;
  /** Monotonic perform id; only the newest perform may apply its grant. */
  let performSeq = 0;

  const cancel = () => {
    if (timer !== undefined) {
      deps.clearTimeoutFn(timer);
      timer = undefined;
    }
  };

  const schedule = () => scheduleRetry(false);

  /**
   * `force` is used only by the in-flight perform's own failure path: fresh
   * losses cannot arrive while a perform runs, so an external schedule()
   * during flight would only produce a redundant post-connect reconnect.
   */
  const scheduleRetry = (force: boolean) => {
    if (deps.isDisposed() || timer !== undefined || (!force && inFlight !== null)) return;
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

  const run = async (resetAttempts: boolean): Promise<void> => {
    const session = deps.session();
    if (session === null || deps.isDisposed()) return;
    if (resetAttempts) attempts = 0;
    cancel();
    attempts += 1;
    const myPerform = ++performSeq;
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
        scheduleRetry(true);
        return;
      }
      deps.failSession(safe.retryable ? safe : CONNECTION_LOST_FATAL);
      return;
    }
    if (deps.isDisposed() || deps.generation() !== gen) return;
    // Single-flight makes concurrent mints impossible, but belt-and-braces:
    // a grant from any superseded perform is dropped, never applied.
    if (myPerform !== performSeq) return;
    deps.onGrant(grant.transport);
  };

  const loop: VoiceReconnectLoop = {
    noteRetryAfter(ms) {
      retryAfterMs = Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RECONNECT_DELAY_MS) : 0;
    },
    retryAfter() {
      return retryAfterMs;
    },
    schedule,
    perform(resetAttempts) {
      // A second caller (manual retry, scheduled timer, controller retry)
      // joins the in-flight attempt instead of minting a competing epoch.
      if (inFlight !== null) {
        return inFlight;
      }
      const pending = run(resetAttempts).finally(() => {
        if (inFlight === pending) inFlight = null;
      });
      inFlight = pending;
      return pending;
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

const CLEANUP_MAX_ATTEMPTS = 3;
const CLEANUP_BASE_DELAY_MS = 250;
const CLEANUP_MAX_DELAY_MS = 2_000;
const CLEANUP_MAX_JOBS = 32;
const CLEANUP_MAX_SETTLED = 64;
const CLEANUP_MAX_FAILED = 64;
/** Explicit retries of an exhausted cleanup are throttled to one cycle per key per window. */
const CLEANUP_RETRY_WINDOW_MS = 60_000;

export interface VoiceRemoteCleanupDeps {
  /** One remote DELETE attempt; resolves only on confirmed deletion. */
  deleteRemote(chatId: string, sessionId: string): Promise<void>;
  setTimeoutFn(callback: () => void, ms: number): unknown;
  clearTimeoutFn(timer: unknown): void;
  /** Clock for the explicit-retry window; defaults to `Date.now`. */
  now?(): number;
  /** Failed-attempt notification; `attempt` is 1-based and always < max. */
  onRetry?(chatId: string, sessionId: string, attempt: number, error: unknown): void;
  /**
   * Fires once when a job can never complete — attempts exhausted or the
   * queue was full. Cleanup failure is never silent: the caller must retain
   * a discoverable, safe notice.
   */
  onExhausted(chatId: string, sessionId: string): void;
  /**
   * Fires when a job's DELETE confirms — including a cycle started by an
   * explicit retry — so the caller can retire a stale failure notice.
   */
  onSettled?(chatId: string, sessionId: string): void;
}

export interface VoiceRemoteCleanupQueue {
  /**
   * Enqueues a cleanup keyed by the captured chat/session pair. In-flight,
   * already-settled, and previously-failed jobs for the same key are
   * deduped, so repeated teardown paths stay cheap and dispose never
   * restarts retries automatically.
   */
  enqueue(chatId: string, sessionId: string): void;
  /** True only after the remote DELETE confirmed. */
  isSettled(chatId: string, sessionId: string): boolean;
  /** True when the key exhausted its attempts and awaits an explicit retry. */
  isFailed(chatId: string, sessionId: string): boolean;
  /** Failed keys awaiting an explicit cleanup retry. */
  failedSize(): number;
  /**
   * Explicitly retries one failed cleanup. Returns false when the key is
   * not failed or its last cycle ended inside the 60s retry window; on
   * success the key re-enters the bounded attempt ladder from zero.
   */
  retryCleanup(chatId: string, sessionId: string): boolean;
  /** Retries every failed key within its window; returns cycles started. */
  retryFailed(): number;
  /** In-flight job count (retries pending included). */
  size(): number;
}

interface CleanupJob {
  key: string;
  chatId: string;
  sessionId: string;
  attempts: number;
  timer: unknown;
}

/**
 * Bounded best-effort remote-session cleanup. A job settles ONLY after the
 * remote DELETE confirms; failures retry with exponential backoff on the
 * injected timers up to 3 attempts, then move to a separate bounded failed
 * registry — never marked settled — and surface via `onExhausted`. Failed
 * keys are never re-enqueued automatically (dispose stays cheap); only the
 * explicit `retryCleanup`/`retryFailed` path starts a fresh bounded cycle,
 * rate-limited to one cycle per key per 60s. Jobs are keyed by the captured
 * ids, so they stay correct — and keep running — even after the client
 * generation or session identity has moved on.
 */
export function createRemoteCleanupQueue(deps: VoiceRemoteCleanupDeps): VoiceRemoteCleanupQueue {
  const jobs = new Map<string, CleanupJob>();
  const settled = new Set<string>();
  /** key -> exhausted job ids + last-cycle end time; doubles as the 60s retry gate. */
  const failed = new Map<string, { chatId: string; sessionId: string; failedAt: number }>();
  const now = deps.now ?? (() => Date.now());
  const keyOf = (chatId: string, sessionId: string) => `${chatId}/${sessionId}`;

  const evictOldest = <T>(registry: Map<string, T> | Set<string>, max: number) => {
    while (registry.size > max) {
      const oldest = registry.keys().next().value;
      if (oldest === undefined) break;
      registry.delete(oldest);
    }
  };

  const markSettled = (key: string) => {
    failed.delete(key);
    settled.add(key);
    evictOldest(settled, CLEANUP_MAX_SETTLED);
  };

  const markFailed = (job: { key: string; chatId: string; sessionId: string }) => {
    failed.delete(job.key);
    failed.set(job.key, { chatId: job.chatId, sessionId: job.sessionId, failedAt: now() });
    evictOldest(failed, CLEANUP_MAX_FAILED);
  };

  const attempt = (job: CleanupJob) => {
    if (jobs.get(job.key) !== job) return;
    job.attempts += 1;
    void Promise.resolve()
      .then(() => deps.deleteRemote(job.chatId, job.sessionId))
      .then(() => {
        if (!jobs.delete(job.key)) return;
        markSettled(job.key);
        deps.onSettled?.(job.chatId, job.sessionId);
      }, (deleteError: unknown) => {
        if (jobs.get(job.key) !== job) return;
        if (job.attempts >= CLEANUP_MAX_ATTEMPTS) {
          jobs.delete(job.key);
          // Exhausted is NOT settled: the key parks in the failed registry
          // so it stays discoverable and explicitly retryable — teardown
          // enqueues dedupe on it instead of silently retrying forever.
          markFailed(job);
          deps.onExhausted(job.chatId, job.sessionId);
          return;
        }
        deps.onRetry?.(job.chatId, job.sessionId, job.attempts, deleteError);
        const delay = Math.min(
          CLEANUP_BASE_DELAY_MS * 2 ** (job.attempts - 1),
          CLEANUP_MAX_DELAY_MS,
        );
        job.timer = deps.setTimeoutFn(() => {
          job.timer = undefined;
          attempt(job);
        }, delay);
      });
  };

  const startJob = (key: string, chatId: string, sessionId: string) => {
    const job: CleanupJob = { key, chatId, sessionId, attempts: 0, timer: undefined };
    jobs.set(key, job);
    attempt(job);
  };

  const queue: VoiceRemoteCleanupQueue = {
    enqueue(chatId, sessionId) {
      const key = keyOf(chatId, sessionId);
      if (settled.has(key) || jobs.has(key) || failed.has(key)) return;
      if (jobs.size >= CLEANUP_MAX_JOBS) {
        // Never silently drop a cleanup obligation: park it in the failed
        // registry so the caller's notice path fires and an explicit retry
        // can still pick it up instead of re-enqueueing forever.
        markFailed({ key, chatId, sessionId });
        deps.onExhausted(chatId, sessionId);
        return;
      }
      startJob(key, chatId, sessionId);
    },
    isSettled(chatId, sessionId) {
      return settled.has(keyOf(chatId, sessionId));
    },
    isFailed(chatId, sessionId) {
      return failed.has(keyOf(chatId, sessionId));
    },
    failedSize() {
      return failed.size;
    },
    retryCleanup(chatId, sessionId) {
      const key = keyOf(chatId, sessionId);
      const entry = failed.get(key);
      if (entry === undefined || jobs.has(key)) return false;
      if (now() - entry.failedAt < CLEANUP_RETRY_WINDOW_MS) return false;
      failed.delete(key);
      if (jobs.size >= CLEANUP_MAX_JOBS) {
        // Still congested: re-park with the original timestamp so the key
        // remains retryable once the next window opens.
        failed.set(key, entry);
        return false;
      }
      startJob(key, entry.chatId, entry.sessionId);
      return true;
    },
    retryFailed() {
      let started = 0;
      for (const entry of [...failed.values()]) {
        if (queue.retryCleanup(entry.chatId, entry.sessionId)) started += 1;
      }
      return started;
    },
    size() {
      return jobs.size;
    },
  };
  return queue;
}
