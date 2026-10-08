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
