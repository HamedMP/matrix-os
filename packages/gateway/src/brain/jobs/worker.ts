/**
 * The job worker of one gateway: claims queued jobs of its owner up to `concurrency`, runs each job's bounded step
 * again and again until the step is caught up or stops, and keeps the lease alive with heartbeats. Each poll first
 * recovers jobs whose lease expired (a crashed gateway). A step is raced against its run's abort signal, so the time
 * cap, a cancel and shutdown end the run at once even when the step ignores the signal (the step's service call then
 * ends on its own budget). stop() aborts running jobs, hands their leases back and waits up to stopWaitMs for them and
 * for a claim in flight. Timers are unref'd; at most `concurrency` jobs are held in memory.
 */
import { randomBytes } from "node:crypto";
import type { BrainBackgroundJob } from "../contracts.js";
import type { BrainScopeKey } from "../types.js";
import type { BrainClaimedJob, BrainJobOutcome, BrainJobStore } from "./store.js";
import {
  BRAIN_JOB_CODE_PATTERN, BRAIN_JOB_LIMITS, BRAIN_JOB_RETRY_CODES, BRAIN_JOB_WORKER_CEILINGS,
  BRAIN_JOB_WORKER_DEFAULTS, type BrainJobSteps, type BrainJobSummary, type BrainJobWorkerLimits,
} from "./types.js";

export const BRAIN_JOB_WORKER_NAME = "brain-jobs";

export interface BrainJobWorkerDeps {
  readonly store: BrainJobStore;
  readonly ownerId: string;
  readonly steps: BrainJobSteps;
  readonly limits?: Partial<BrainJobWorkerLimits>;
  /** Lease owner name; default a random `w_<hex>` per worker. */
  readonly workerId?: string;
}

export interface BrainJobWorker extends BrainBackgroundJob {
  /** Looks for queued jobs now (after an enqueue); a no-op while stopped. */
  wake(): void;
  /**
   * Stops the job now when this worker is running it (after a cancel was recorded), instead of at its next heartbeat;
   * false when it runs elsewhere or not at all (then the heartbeat or the next step sees the cancel). Uses no `this`,
   * so it can be passed on as a plain function.
   */
  cancel(scope: BrainScopeKey, jobId: string): boolean;
}

type StopReason = "cancelled" | "time_limit" | "lease_lost" | "shutdown";
type RunEnd = BrainJobOutcome | { readonly status: "release" } | { readonly status: "lost" };
type Progress = { steps: number; result: BrainJobSummary | null };

/** Every limit clamped to 1..its ceiling (stepPauseMs may be 0). */
export function resolveBrainJobWorkerLimits(limits: Partial<BrainJobWorkerLimits> = {}): BrainJobWorkerLimits {
  const out: Record<string, number> = {};
  for (const key of Object.keys(BRAIN_JOB_WORKER_DEFAULTS) as (keyof BrainJobWorkerLimits)[]) {
    const value = limits[key] ?? BRAIN_JOB_WORKER_DEFAULTS[key];
    const floor = key === "stepPauseMs" ? 0 : 1;
    const whole = Number.isFinite(value) ? Math.trunc(value) : BRAIN_JOB_WORKER_DEFAULTS[key];
    out[key] = Math.max(floor, Math.min(whole, BRAIN_JOB_WORKER_CEILINGS[key]));
  }
  return out as unknown as BrainJobWorkerLimits;
}

/** Keeps at most summaryKeysMax entries with well-formed keys, finite numbers and clipped strings. */
export function clipBrainJobSummary(summary: BrainJobSummary): BrainJobSummary {
  const out: Record<string, string | number | boolean | null> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(summary)) {
    if (kept >= BRAIN_JOB_LIMITS.summaryKeysMax) break;
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || key.length > BRAIN_JOB_LIMITS.summaryKeyMaxChars) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    out[key] = typeof value === "string" ? value.slice(0, BRAIN_JOB_LIMITS.summaryStringMaxChars) : value;
    kept += 1;
  }
  return out;
}

/** The stable code of a step error: its `code` when it is a well-formed string, else step_failed. */
export function brainJobErrorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && BRAIN_JOB_CODE_PATTERN.test(code) ? code : "step_failed";
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "UnknownError");

/** Resolves after `ms`, or at once when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref();
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * The step's answer, or a rejection with the abort reason as soon as `signal` aborts. A step that ignores the signal
 * is left to end on its own budget; an error it throws after that is logged, unless it is the abort itself.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let open = true;
    const onAbort = () => {
      open = false;
      reject(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    work.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener("abort", onAbort);
      if (open) reject(error);
      else if (error !== signal.reason) console.warn("[brain-jobs] Step failed after its run stopped:", errorName(error));
    });
  });
}

export function createBrainJobWorker(deps: BrainJobWorkerDeps): BrainJobWorker {
  const limits = resolveBrainJobWorkerLimits(deps.limits);
  const workerId = deps.workerId ?? `w_${randomBytes(8).toString("hex")}`;
  const running = new Map<string, AbortController>();
  const tasks = new Set<Promise<void>>();
  let started = false;
  let pumping = false;
  let again = false;
  /** The latest poll; stop() waits for it, so a claim in flight is handed back before stop() returns. */
  let current: Promise<void> = Promise.resolve();
  let poll: NodeJS.Timeout | null = null;

  async function runSteps(job: BrainClaimedJob, signal: AbortSignal, progress: Progress): Promise<RunEnd> {
    const step = deps.steps[job.request.kind];
    if (step === undefined) return { status: "failed", errorCode: "job_kind_unavailable", ...progress };
    // The busy code of the last answer while waiting to try again; the time cap then fails the run with it.
    let busy: string | null = null;
    for (;;) {
      if (signal.aborted) return fromAbort(signal.reason as StopReason, progress, busy);
      if (progress.steps >= limits.maxSteps) return { status: "failed", errorCode: "step_limit", ...progress };
      busy = null;
      let result;
      try {
        result = await untilAborted(step({
          ownerId: job.scope.ownerId, projectId: job.projectId, scope: job.scope, request: job.request, signal,
          step: progress.steps + 1,
        }), signal);
      } catch (error: unknown) {
        if (signal.aborted) return fromAbort(signal.reason as StopReason, progress, busy);
        const code = brainJobErrorCode(error);
        if (code === "step_failed") console.error("[brain-jobs] Step failed:", errorName(error));
        if (!BRAIN_JOB_RETRY_CODES.has(code)) return { status: "failed", errorCode: code, ...progress };
        // Busy (another run holds the lock): try again until the time cap; a busy answer is not a step. The first busy
        // answer of a wait is recorded as `waiting`, so a client can say the run waits (the next step replaces it).
        if (progress.result?.waiting !== code) {
          progress.result = clipBrainJobSummary({ ...(progress.result ?? {}), waiting: code });
          const beat = await deps.store.heartbeat(job, workerId, limits.leaseMs, progress);
          if (!beat.owned) return { status: "lost" };
          if (beat.cancelRequested) return { status: "cancelled", errorCode: null, ...progress };
        }
        busy = code;
        await pause(limits.retryDelayMs, signal);
        continue;
      }
      progress.steps += 1;
      progress.result = clipBrainJobSummary(result.summary);
      if (result.stopCode !== null) {
        const code = BRAIN_JOB_CODE_PATTERN.test(result.stopCode) ? result.stopCode : "step_failed";
        return { status: "failed", errorCode: code, ...progress };
      }
      if (result.caughtUp) return { status: "succeeded", errorCode: null, ...progress };
      const beat = await deps.store.heartbeat(job, workerId, limits.leaseMs, progress);
      if (!beat.owned) return { status: "lost" };
      if (beat.cancelRequested) return { status: "cancelled", errorCode: null, ...progress };
      await pause(limits.stepPauseMs, signal);
    }
  }

  function fromAbort(reason: StopReason, progress: Progress, busy: string | null): RunEnd {
    if (reason === "cancelled") return { status: "cancelled", errorCode: null, ...progress };
    if (reason === "time_limit") return { status: "failed", errorCode: busy ?? "time_limit", ...progress };
    return { status: reason === "shutdown" ? "release" : "lost" };
  }

  async function runJob(job: BrainClaimedJob, controller: AbortController): Promise<void> {
    const progress: Progress = { steps: job.steps, result: null };
    const limitTimer = setTimeout(() => controller.abort("time_limit"), limits.jobWallClockMs);
    limitTimer.unref();
    const beatTimer = setInterval(() => {
      if (controller.signal.aborted) return;
      deps.store.heartbeat(job, workerId, limits.leaseMs).then((beat) => {
        if (!beat.owned) controller.abort("lease_lost");
        else if (beat.cancelRequested) controller.abort("cancelled");
      }, (error: unknown) => console.error("[brain-jobs] Heartbeat failed:", errorName(error)));
    }, limits.heartbeatMs);
    beatTimer.unref();
    let end: RunEnd;
    try {
      end = await runSteps(job, controller.signal, progress);
    } finally {
      clearTimeout(limitTimer);
      clearInterval(beatTimer);
    }
    if (end.status === "lost") return;
    const written = end.status === "release"
      ? await deps.store.release(job, workerId, progress)
      : await deps.store.finish(job, workerId, end);
    if (!written) console.warn("[brain-jobs] Job lease lost before its result was written");
  }

  const runKey = (scope: BrainScopeKey, jobId: string): string => JSON.stringify([scope.ownerId, scope.scopeId, jobId]);

  function launch(job: BrainClaimedJob): void {
    const key = runKey(job.scope, job.jobId);
    const controller = new AbortController();
    running.set(key, controller);
    const task: Promise<void> = runJob(job, controller)
      .catch((error: unknown) => console.error("[brain-jobs] Job run failed:", errorName(error)))
      .finally(() => {
        running.delete(key);
        tasks.delete(task);
        if (started) pump();
      });
    tasks.add(task);
  }

  /** One poll at a time; a wake during a poll runs one more pass of it. */
  function pump(): void {
    if (pumping) {
      again = true;
      return;
    }
    current = drain();
  }

  async function drain(): Promise<void> {
    pumping = true;
    try {
      do {
        again = false;
        if (!started) break;
        const recovered = await deps.store.recover(deps.ownerId, limits.maxAttempts);
        if (recovered.requeued + recovered.closed > 0) {
          console.warn(`[brain-jobs] Expired leases: ${recovered.requeued} queued again, ${recovered.closed} closed`);
        }
        while (started && running.size < limits.concurrency) {
          const job = await deps.store.claim(deps.ownerId, workerId, limits.leaseMs);
          if (job === null) break;
          if (!started) {
            // stop() ran while this claim was in flight: hand the job straight back.
            const released = await deps.store.release(job, workerId, { steps: job.steps, result: null });
            if (!released) console.warn("[brain-jobs] Job lease lost before its result was written");
            break;
          }
          launch(job);
        }
      } while (again);
    } catch (error: unknown) {
      console.error("[brain-jobs] Poll failed:", errorName(error));
    } finally {
      pumping = false;
    }
  }

  return {
    name: BRAIN_JOB_WORKER_NAME,
    start() {
      if (started) return;
      started = true;
      poll = setInterval(pump, limits.pollMs);
      poll.unref();
      pump();
    },
    wake() {
      if (started) pump();
    },
    cancel(scope, jobId) {
      const controller = running.get(runKey(scope, jobId));
      if (controller === undefined || controller.signal.aborted) return false;
      controller.abort("cancelled");
      return true;
    },
    async stop() {
      started = false;
      if (poll !== null) clearInterval(poll);
      poll = null;
      for (const controller of running.values()) controller.abort("shutdown");
      if (tasks.size === 0 && !pumping) return;
      let wait: NodeJS.Timeout | undefined;
      await Promise.race([Promise.allSettled([current, ...tasks]), new Promise<void>((resolve) => {
        wait = setTimeout(resolve, limits.stopWaitMs);
        wait.unref();
      })]);
      clearTimeout(wait);
    },
  };
}
