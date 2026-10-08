/**
 * The only reader and writer of brain_jobs. Enqueue and erase take the owner's job lock; worker writes (claim,
 * heartbeat, finish, release) are fenced by `status = 'running' AND lease_owner = <worker>` instead, so a worker that
 * lost its lease can never overwrite the job. Claims use FOR UPDATE SKIP LOCKED, so gateways never take the same job.
 * Every write sets lock_timeout and statement_timeout; reads run through withBrainRead.
 */
import { randomBytes } from "node:crypto";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { withBrainRead } from "../bounded.js";
import type { BrainDatabase, BrainScopeKey } from "../types.js";
import { BRAIN_JOBS_OWNER_LOCK, type BrainJobTables, type BrainJobsDatabase, type BrainJobsTable } from "./database.js";
import {
  BRAIN_JOB_ACTIVE_STATUSES, BRAIN_JOB_INTERRUPTED_CODE, BRAIN_JOB_LIMITS, BrainJobError, BrainJobRequestSchema,
  brainJobTarget,
  type BrainJobKind, type BrainJobRequest, type BrainJobStatus, type BrainJobSummary, type BrainJobView,
} from "./types.js";

type JobsDb = Kysely<BrainJobsDatabase>;
type JobsTrx = Transaction<BrainJobsDatabase>;
type JobRow = Selectable<BrainJobsTable>;

/** A job a worker holds the lease of. */
export interface BrainClaimedJob {
  readonly scope: BrainScopeKey; readonly jobId: string; readonly projectId: string;
  readonly request: BrainJobRequest; readonly attempts: number; readonly steps: number;
}
export type BrainJobFinalStatus = Extract<BrainJobStatus, "succeeded" | "failed" | "cancelled">;
export interface BrainJobOutcome {
  readonly status: BrainJobFinalStatus; readonly errorCode: string | null;
  readonly steps: number; readonly result: BrainJobSummary | null;
}
export interface BrainJobProgress { readonly steps: number; readonly result: BrainJobSummary | null }
export interface BrainJobHeartbeat { readonly owned: boolean; readonly cancelRequested: boolean }
export interface BrainJobRecovery { readonly requeued: number; readonly closed: number }

const iso = (value: Date | string): string => new Date(value).toISOString();
const isoOrNull = (value: Date | string | null): string | null => (value === null ? null : iso(value));

function readRequest(row: JobRow): BrainJobRequest {
  const parsed = BrainJobRequestSchema.safeParse(row.request);
  if (parsed.success) return parsed.data;
  console.error("[brain-jobs] Stored request unreadable:", parsed.error.name);
  return BrainJobRequestSchema.parse({ kind: row.kind });
}

function toView(row: JobRow): BrainJobView {
  return {
    jobId: row.job_id, projectId: row.project_id, kind: row.kind as BrainJobKind, request: readRequest(row),
    status: row.status as BrainJobStatus, attempts: row.attempts, steps: row.steps,
    cancelRequested: row.cancel_requested, errorCode: row.error_code,
    result: (row.result ?? null) as BrainJobSummary | null, createdAt: iso(row.created_at),
    startedAt: isoOrNull(row.started_at), heartbeatAt: isoOrNull(row.heartbeat_at),
    finishedAt: isoOrNull(row.finished_at), updatedAt: iso(row.updated_at),
  };
}

const json = (value: BrainJobSummary | null): string | null => (value === null ? null : JSON.stringify(value));

/**
 * A paid run (a model extract): never queued again after a restart or a lost lease, since its next claim would start
 * another paid pass. It ends failed with BRAIN_JOB_INTERRUPTED_CODE instead; the owner runs it again by choice.
 */
const PAID = sql<boolean>`(kind = 'extract' AND target = 'model')`;

export interface BrainJobStoreOptions { readonly now?: () => Date }
