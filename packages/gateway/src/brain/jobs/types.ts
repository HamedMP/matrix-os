/**
 * Background runs of the Company Brain: the limits, the request schema, the injected step contract and the job error
 * class. The kinds, statuses, views and the service shape are the contract in contracts/jobs.ts, re-exported here.
 * Types, constants and the one error class only.
 */
import { z } from "zod/v4";
import {
  BRAIN_FEATURE_ERRORS, BRAIN_JOB_BODY_MAX_BYTES, type BrainFeatureErrorCode, type BrainJobKind, type BrainJobRequest,
  type BrainJobRequestInput, type BrainJobStatus, type BrainJobSummary,
} from "../contracts.js";
import type { BrainScopeKey } from "../types.js";

export {
  BRAIN_JOB_KINDS, BRAIN_JOB_STATUSES, type BrainJobEnqueueView, type BrainJobKind, type BrainJobRequest,
  type BrainJobRequestInput, type BrainJobsListView, type BrainJobsService, type BrainJobStatus, type BrainJobSummary,
  type BrainJobView,
} from "../contracts.js";

/** Statuses that hold the (scope, kind, target) slot: a second request for the same slot gets this job back. */
export const BRAIN_JOB_ACTIVE_STATUSES = ["queued", "running"] as const satisfies readonly BrainJobStatus[];

export const BRAIN_JOB_ID_PATTERN = /^job_[a-f0-9]{32}$/;
/** Stop and error codes stored on a job: lowercase words joined by "_". */
export const BRAIN_JOB_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
/** A paid run (a model extract) cut short by a restart or a lost lease: it is never queued again on its own. */
export const BRAIN_JOB_INTERRUPTED_CODE = "interrupted";

export const BRAIN_JOB_LIMITS = {
  /** Queued and running jobs of one owner across all scopes; one more is jobs_full. */
  activePerOwner: 100,
  /** Finished jobs kept per scope, newest first; older ones are pruned when a job is enqueued. */
  finishedPerScope: 50,
  /** Jobs GET .../jobs returns at most, and its default. */
  listMax: 50, listDefault: 20,
  /** Result summary: keys, key length, string value length. */
  summaryKeysMax: 16, summaryKeyMaxChars: 40, summaryStringMaxChars: 200,
  /** POST bodies. */
  bodyMaxBytes: BRAIN_JOB_BODY_MAX_BYTES,
} as const;

/** Worker settings; every one can be lowered (tests) or raised up to its ceiling. */
export interface BrainJobWorkerLimits {
  /** Jobs this gateway runs at once. */
  readonly concurrency: number;
  /** A claimed job's lease; renewed by every heartbeat. A job whose lease expires is queued again. */
  readonly leaseMs: number;
  /** Lease renewal while a step runs; at most a third of leaseMs (a longer one is shortened to that). */
  readonly heartbeatMs: number;
  /** How often the worker looks for queued jobs and expired leases when nothing woke it. */
  readonly pollMs: number;
  /** Wall clock one claim of a job may use; then the job fails with time_limit. */
  readonly jobWallClockMs: number;
  /** Steps one job may run in total; then the job fails with step_limit. */
  readonly maxSteps: number;
  /** Claims of one job; a job whose lease expired this many times fails with attempts_exhausted. */
  readonly maxAttempts: number;
  /**
   * Wait before trying again a step that answered a busy code (BRAIN_JOB_RETRY_CODES). Busy answers are not steps and
   * are tried again until jobWallClockMs; a run that reaches the cap while waiting fails with the busy code.
   */
  readonly retryDelayMs: number;
  /** Pause between two steps of one job, so a long run leaves room on the owner pool. */
  readonly stepPauseMs: number;
  /** How long stop() waits for running jobs to hand their leases back. */
  readonly stopWaitMs: number;
}

export const BRAIN_JOB_WORKER_DEFAULTS: BrainJobWorkerLimits = {
  concurrency: 2, leaseMs: 60_000, heartbeatMs: 15_000, pollMs: 5_000, jobWallClockMs: 15 * 60_000,
  maxSteps: 500, maxAttempts: 3, retryDelayMs: 5_000, stepPauseMs: 250, stopWaitMs: 5_000,
};
export const BRAIN_JOB_WORKER_CEILINGS: BrainJobWorkerLimits = {
  concurrency: 8, leaseMs: 10 * 60_000, heartbeatMs: 5 * 60_000, pollMs: 5 * 60_000, jobWallClockMs: 60 * 60_000,
  maxSteps: 5_000, maxAttempts: 10, retryDelayMs: 60_000, stepPauseMs: 10_000, stopWaitMs: 30_000,
};

/**
 * Step errors that mean "busy, try again soon" (another run of the same lock, such as a rules and a model extract of
 * one scope, or a git sync asked by id and by default): the step is tried again until the time cap.
 */
export const BRAIN_JOB_RETRY_CODES: ReadonlySet<string> = new Set([
  "sync_in_progress", "extraction_in_progress", "brain_unavailable",
]);

const SourceIdSchema = z.string().regex(/^src_[a-f0-9]{32}$/);

/** POST .../jobs body: one strict shape per kind. */
export const BrainJobRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sync"), sourceId: SourceIdSchema.optional() }).strict(),
  z.object({ kind: z.literal("extract"), extractor: z.enum(["rules", "model"]).default("rules") }).strict(),
  z.object({ kind: z.literal("search_refresh") }).strict(),
  z.object({ kind: z.literal("graph_refresh") }).strict(),
  z.object({ kind: z.literal("brief"), window: z.enum(["day", "week"]).default("day") }).strict(),
]);

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** The schema reads exactly the contract's input and yields exactly its request (fails the typecheck otherwise). */
export const BRAIN_JOB_REQUEST_SCHEMA_MATCHES: readonly [
  Same<z.output<typeof BrainJobRequestSchema>, BrainJobRequest>,
  Same<z.input<typeof BrainJobRequestSchema>, BrainJobRequestInput>,
] = [true, true];

/**
 * The dedupe slot inside (scope, kind): the source of a sync ("git" for the project's git source), the extractor of
 * an extract, the window of a brief, "" for the index refreshes.
 */
export function brainJobTarget(request: BrainJobRequest): string {
  switch (request.kind) {
    case "sync": return request.sourceId ?? "git";
    case "extract": return request.extractor;
    case "brief": return request.window;
    default: return "";
  }
}

/** One bounded run of the job's work. step counts from 1 across all claims of the job. */
export interface BrainJobStepContext {
  readonly ownerId: string; readonly projectId: string; readonly scope: BrainScopeKey;
  readonly request: BrainJobRequest; readonly signal: AbortSignal; readonly step: number;
}

/**
 * caughtUp: nothing is left for this job. stopCode: the run cannot go on (the job fails with it). Otherwise the
 * worker runs the step again. Errors thrown by a step fail the job with their code, or are retried when busy.
 */
export interface BrainJobStepResult {
  readonly caughtUp: boolean; readonly stopCode: string | null; readonly summary: BrainJobSummary;
}
export type BrainJobStep = (context: BrainJobStepContext) => Promise<BrainJobStepResult>;
export type BrainJobSteps = Readonly<Partial<Record<BrainJobKind, BrainJobStep>>>;

export type BrainJobErrorCode = Extract<BrainFeatureErrorCode, "job_not_found" | "job_kind_unavailable" | "jobs_full">;

/** The only client-facing text for job errors: the shared feature error table. */
export const BRAIN_JOB_ERRORS: {
  readonly [Code in BrainJobErrorCode]: (typeof BRAIN_FEATURE_ERRORS)[Code];
} = {
  job_not_found: BRAIN_FEATURE_ERRORS.job_not_found,
  job_kind_unavailable: BRAIN_FEATURE_ERRORS.job_kind_unavailable,
  jobs_full: BRAIN_FEATURE_ERRORS.jobs_full,
};

export class BrainJobError extends Error {
  constructor(readonly code: BrainJobErrorCode) {
    super("Company brain request failed");
    this.name = "BrainJobError";
  }
}
