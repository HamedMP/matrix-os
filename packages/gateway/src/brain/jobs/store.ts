/**
 * The only reader and writer of brain_jobs. Enqueue and erase take the owner's job lock; worker writes (heartbeat,
 * finish, release) are fenced by their claim instead (`status = 'running' AND lease_owner = <the claim's lease>`), a
 * value no other claim has, so a run that lost its lease or handed it back can never overwrite the job, not even after
 * the same worker claimed it again. Claims use FOR UPDATE SKIP LOCKED, so gateways never take the same job. Every
 * write sets lock_timeout and statement_timeout; reads run through withBrainRead.
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

/** A job a worker holds the lease of; `lease` (its lease_owner: the worker id and a random tag) is this claim's. */
export interface BrainClaimedJob {
  readonly scope: BrainScopeKey; readonly jobId: string; readonly projectId: string; readonly lease: string;
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

/** The predicate of brain_jobs_active_slot, as literals so Postgres matches ON CONFLICT to it under any plan. */
const ACTIVE_SLOT = sql<boolean>`status IN ('queued', 'running')`;

export interface BrainJobStoreOptions { readonly now?: () => Date }

export class BrainJobStore {
  private readonly db: JobsDb;
  private readonly now: () => Date;

  constructor(db: Kysely<BrainDatabase>, options: BrainJobStoreOptions = {}) {
    this.db = db.withTables<BrainJobTables>();
    this.now = options.now ?? (() => new Date());
  }

  private write<T>(work: (trx: JobsTrx) => Promise<T>, ownerLock?: string): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
      await sql`SET LOCAL statement_timeout = '15s'`.execute(trx);
      if (ownerLock !== undefined) {
        await sql`SELECT pg_advisory_xact_lock(hashtext(${ownerLock}), hashtext(${BRAIN_JOBS_OWNER_LOCK}))`
          .execute(trx);
      }
      return work(trx);
    });
  }

  /**
   * Queues a job, or returns the queued or running job of the same (scope, kind, target) with created false. The
   * insert is ON CONFLICT DO NOTHING on brain_jobs_active_slot, so the slot holds even against a writer outside the
   * owner lock; the lock keeps the active cap exact. Throws jobs_full past BRAIN_JOB_LIMITS.activePerOwner; prunes the
   * scope's finished jobs to finishedPerScope. `admit` runs under the owner lock first and refuses by throwing (the
   * service checks the project is still live): eraseScope takes the same lock, so no job lands after a scope erase.
   */
  enqueue(scope: BrainScopeKey, projectId: string, request: BrainJobRequest, admit?: () => Promise<unknown>):
    Promise<{ readonly job: BrainJobView; readonly created: boolean }> {
    const target = brainJobTarget(request);
    return this.write(async (trx) => {
      await admit?.();
      const active = () => trx.selectFrom("brain_jobs").selectAll()
        .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
        .where("kind", "=", request.kind).where("target", "=", target)
        .where("status", "in", BRAIN_JOB_ACTIVE_STATUSES);
      // Checked before the cap, so asking again for a held slot dedupes even when the owner is at the cap.
      const existing = await active().executeTakeFirst();
      if (existing !== undefined) return { job: toView(existing), created: false };
      const { n } = await trx.selectFrom("brain_jobs").select((eb) => eb.fn.countAll<number>().as("n"))
        .where("owner_id", "=", scope.ownerId).where("status", "in", BRAIN_JOB_ACTIVE_STATUSES)
        .executeTakeFirstOrThrow();
      if (Number(n) >= BRAIN_JOB_LIMITS.activePerOwner) throw new BrainJobError("jobs_full");
      const now = this.now();
      const row = await trx.insertInto("brain_jobs").values({
        owner_id: scope.ownerId, scope_id: scope.scopeId, job_id: `job_${randomBytes(16).toString("hex")}`,
        project_id: projectId, kind: request.kind, target, request: JSON.stringify(request), status: "queued",
        attempts: 0, steps: 0, lease_owner: null, lease_expires_at: null, cancel_requested: false, result: null,
        error_code: null, created_at: now, started_at: null, heartbeat_at: null, finished_at: null, updated_at: now,
      }).onConflict((oc) => oc.columns(["owner_id", "scope_id", "kind", "target"]).where(ACTIVE_SLOT).doNothing())
        .returningAll().executeTakeFirst();
      // The slot was taken after the check by a writer outside the owner lock (brain_jobs_active_slot): a dedupe.
      if (row === undefined) return { job: toView(await active().executeTakeFirstOrThrow()), created: false };
      await sql`
        DELETE FROM brain_jobs
        WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId} AND finished_at IS NOT NULL
          AND job_id NOT IN (
            SELECT job_id FROM brain_jobs
            WHERE owner_id = ${scope.ownerId} AND scope_id = ${scope.scopeId} AND finished_at IS NOT NULL
            ORDER BY finished_at DESC, job_id DESC LIMIT ${BRAIN_JOB_LIMITS.finishedPerScope})`.execute(trx);
      return { job: toView(row), created: true };
    }, scope.ownerId);
  }

  async get(scope: BrainScopeKey, jobId: string): Promise<BrainJobView | null> {
    const row = await withBrainRead(this.db, (trx) => trx.selectFrom("brain_jobs").selectAll()
      .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("job_id", "=", jobId)
      .executeTakeFirst());
    return row === undefined ? null : toView(row);
  }

  /** Newest first; limit is clamped to 1..BRAIN_JOB_LIMITS.listMax. */
  async list(scope: BrainScopeKey, limit: number): Promise<readonly BrainJobView[]> {
    const bounded = Math.max(1, Math.min(Math.trunc(limit) || 1, BRAIN_JOB_LIMITS.listMax));
    const rows = await withBrainRead(this.db, (trx) => trx.selectFrom("brain_jobs").selectAll()
      .where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId)
      .orderBy("created_at", "desc").orderBy("job_id", "desc").limit(bounded).execute());
    return rows.map(toView);
  }

  /**
   * A queued job becomes cancelled at once; a running one gets cancel_requested and its worker stops it at the next
   * heartbeat or step. A finished job is returned unchanged; null when the job is not in the scope.
   */
  async cancel(scope: BrainScopeKey, jobId: string): Promise<BrainJobView | null> {
    const now = this.now();
    const row = await this.write((trx) => trx.updateTable("brain_jobs").set({
      status: sql`CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END`,
      cancel_requested: sql`status = 'running'`,
      finished_at: sql`CASE WHEN status = 'queued' THEN ${now}::timestamptz ELSE finished_at END`,
      updated_at: now,
    }).where("owner_id", "=", scope.ownerId).where("scope_id", "=", scope.scopeId).where("job_id", "=", jobId)
      .where("status", "in", BRAIN_JOB_ACTIVE_STATUSES).returningAll().executeTakeFirst());
    return row === undefined ? this.get(scope, jobId) : toView(row);
  }

  /**
   * Running jobs of the owner whose lease expired: cancelled when a cancel was asked, failed with interrupted when the
   * run is paid, failed with attempts_exhausted after maxAttempts claims, else queued again for the next claim.
   */
  async recover(ownerId: string, maxAttempts: number): Promise<BrainJobRecovery> {
    const now = this.now();
    const rows = await this.write((trx) => trx.updateTable("brain_jobs").set({
      status: sql`CASE WHEN cancel_requested THEN 'cancelled' WHEN ${PAID} OR attempts >= ${maxAttempts} THEN 'failed'
        ELSE 'queued' END`,
      error_code: sql`CASE WHEN cancel_requested THEN error_code WHEN ${PAID} THEN ${BRAIN_JOB_INTERRUPTED_CODE}
        WHEN attempts >= ${maxAttempts} THEN 'attempts_exhausted' ELSE error_code END`,
      finished_at: sql`CASE WHEN cancel_requested OR ${PAID} OR attempts >= ${maxAttempts} THEN ${now}::timestamptz END`,
      lease_owner: null, lease_expires_at: null, updated_at: now,
    }).where("owner_id", "=", ownerId).where("status", "=", "running").where("lease_expires_at", "<", now)
      .returning("status").execute());
    const requeued = rows.filter((row) => row.status === "queued").length;
    return { requeued, closed: rows.length - requeued };
  }

  /**
   * Takes the owner's oldest queued job for `workerId` (attempts + 1), or null when none is queued. The claim's lease
   * fences its writes; its random tag keeps it unique even when the same worker claims a job it handed back (release
   * does not count a claim, so attempts can repeat).
   */
  async claim(ownerId: string, workerId: string, leaseMs: number): Promise<BrainClaimedJob | null> {
    const now = this.now();
    // lease_owner holds at most 64 characters: up to 47 of the worker id (well-formed, so it is stored as written), a
    // colon and 16 random hex digits.
    const lease = `${workerId.slice(0, 47).toWellFormed()}:${randomBytes(8).toString("hex")}`;
    const row = await this.write(async (trx) => {
      const { rows } = await sql<JobRow>`
        UPDATE brain_jobs SET status = 'running', lease_owner = ${lease},
          lease_expires_at = ${new Date(now.getTime() + leaseMs)}, attempts = attempts + 1,
          started_at = COALESCE(started_at, ${now}), heartbeat_at = ${now}, updated_at = ${now}
        WHERE (owner_id, scope_id, job_id) IN (
          SELECT owner_id, scope_id, job_id FROM brain_jobs WHERE owner_id = ${ownerId} AND status = 'queued'
          ORDER BY created_at, job_id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`.execute(trx);
      return rows[0];
    });
    if (row === undefined) return null;
    return {
      scope: { ownerId: row.owner_id, scopeId: row.scope_id }, jobId: row.job_id, projectId: row.project_id, lease,
      request: readRequest(row), attempts: row.attempts, steps: row.steps,
    };
  }

  /** Renews the lease (and records progress when given); owned false when the job is no longer this claim's. */
  async heartbeat(job: BrainClaimedJob, leaseMs: number, progress?: BrainJobProgress): Promise<BrainJobHeartbeat> {
    const now = this.now();
    const row = await this.write((trx) => trx.updateTable("brain_jobs").set({
      lease_expires_at: new Date(now.getTime() + leaseMs), heartbeat_at: now, updated_at: now,
      ...(progress === undefined ? {} : { steps: progress.steps, result: json(progress.result) }),
    }).where("owner_id", "=", job.scope.ownerId).where("scope_id", "=", job.scope.scopeId)
      .where("job_id", "=", job.jobId).where("status", "=", "running").where("lease_owner", "=", job.lease)
      .returning("cancel_requested").executeTakeFirst());
    return { owned: row !== undefined, cancelRequested: row?.cancel_requested === true };
  }

  /**
   * Writes the final status; false when the job is no longer this claim's (nothing is written). A cancel recorded
   * before this write wins over the outcome (cancelled, no error code), as in release and recover: the cancel can land
   * while the last step completes, when the worker no longer looks for it.
   */
  async finish(job: BrainClaimedJob, outcome: BrainJobOutcome): Promise<boolean> {
    const now = this.now();
    const row = await this.write((trx) => trx.updateTable("brain_jobs").set({
      status: sql`CASE WHEN cancel_requested THEN 'cancelled' ELSE ${outcome.status}::text END`,
      error_code: sql`CASE WHEN cancel_requested THEN NULL ELSE ${outcome.errorCode}::text END`,
      steps: outcome.steps, result: json(outcome.result),
      lease_owner: null, lease_expires_at: null, finished_at: now, updated_at: now,
    }).where("owner_id", "=", job.scope.ownerId).where("scope_id", "=", job.scope.scopeId)
      .where("job_id", "=", job.jobId).where("status", "=", "running").where("lease_owner", "=", job.lease)
      .returning("job_id").executeTakeFirst());
    return row !== undefined;
  }

  /**
   * Hands a job back on shutdown: queued again with the claim not counted as an attempt, cancelled when a cancel was
   * asked, or failed with interrupted when the run is paid. A null result keeps the stored one.
   */
  async release(job: BrainClaimedJob, progress: BrainJobProgress): Promise<boolean> {
    const now = this.now();
    const row = await this.write((trx) => trx.updateTable("brain_jobs").set({
      status: sql`CASE WHEN cancel_requested THEN 'cancelled' WHEN ${PAID} THEN 'failed' ELSE 'queued' END`,
      error_code: sql`CASE WHEN NOT cancel_requested AND ${PAID} THEN ${BRAIN_JOB_INTERRUPTED_CODE} ELSE error_code END`,
      attempts: sql`CASE WHEN cancel_requested OR ${PAID} THEN attempts ELSE GREATEST(attempts - 1, 0) END`,
      finished_at: sql`CASE WHEN cancel_requested OR ${PAID} THEN ${now}::timestamptz END`,
      lease_owner: null, lease_expires_at: null, steps: progress.steps,
      result: sql`COALESCE(${json(progress.result)}::jsonb, result)`, updated_at: now,
    }).where("owner_id", "=", job.scope.ownerId).where("scope_id", "=", job.scope.scopeId)
      .where("job_id", "=", job.jobId).where("status", "=", "running").where("lease_owner", "=", job.lease)
      .returning("job_id").executeTakeFirst());
    return row !== undefined;
  }

  /** Removes every job of the scope (project erase); a worker still running one finds it gone and stops. */
  async eraseScope(scope: BrainScopeKey): Promise<number> {
    const rows = await this.write((trx) => trx.deleteFrom("brain_jobs").where("owner_id", "=", scope.ownerId)
      .where("scope_id", "=", scope.scopeId).returning("job_id").execute(), scope.ownerId);
    return rows.length;
  }
}
