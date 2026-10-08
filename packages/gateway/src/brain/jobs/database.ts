/**
 * The brain_jobs table: one idempotent bootstrap under its own schema lock. Scope-level rows with no foreign key to
 * the core tables; BrainJobStore.eraseScope (store.ts) removes a scope's rows when its project is erased.
 */
import { sql, type ColumnType, type Kysely } from "kysely";
import type { BrainDatabase } from "../types.js";
import { BRAIN_JOB_LIMITS, BRAIN_JOB_WORKER_CEILINGS } from "./types.js";

export const BRAIN_JOBS_SCHEMA_LOCK = "brain_jobs_schema";
/** Per-owner write lock of brain_jobs: pg_advisory_xact_lock(hashtext(ownerId), hashtext(BRAIN_JOBS_OWNER_LOCK)). */
export const BRAIN_JOBS_OWNER_LOCK = "brain-jobs";

type Time = ColumnType<Date, Date | string, Date | string>;
type NullableTime = ColumnType<Date | null, Date | string | null, Date | string | null>;
type Json = ColumnType<unknown, string, string>;
type NullableJson = ColumnType<unknown, string | null, string | null>;

export type BrainJobsTable = {
  owner_id: string; scope_id: string; job_id: string; project_id: string; kind: string; target: string;
  request: Json; status: string; attempts: number; steps: number; lease_owner: string | null;
  lease_expires_at: NullableTime; cancel_requested: boolean; result: NullableJson; error_code: string | null;
  created_at: Time; started_at: NullableTime; heartbeat_at: NullableTime; finished_at: NullableTime;
  updated_at: Time;
};
export type BrainJobTables = { brain_jobs: BrainJobsTable };
export type BrainJobsDatabase = BrainDatabase & BrainJobTables;

export async function bootstrapBrainJobsDatabase(db: Kysely<BrainDatabase>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`SET LOCAL statement_timeout = '30s'`.execute(trx);
    await sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext(${BRAIN_JOBS_SCHEMA_LOCK}))`
      .execute(trx);
    await sql`
      CREATE TABLE IF NOT EXISTS brain_jobs (
        owner_id TEXT NOT NULL CHECK (char_length(owner_id) BETWEEN 1 AND 256),
        scope_id TEXT NOT NULL CHECK (char_length(scope_id) BETWEEN 1 AND 256),
        job_id TEXT NOT NULL CHECK (job_id ~ '^job_[a-f0-9]{32}$'),
        project_id TEXT NOT NULL CHECK (char_length(project_id) BETWEEN 1 AND 256),
        kind TEXT NOT NULL CHECK (kind IN ('sync', 'extract', 'search_refresh', 'graph_refresh', 'brief')),
        target TEXT NOT NULL CHECK (char_length(target) <= 64),
        request JSONB NOT NULL CHECK (jsonb_typeof(request) = 'object' AND octet_length(request::text) <= 1024),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
        attempts INTEGER NOT NULL DEFAULT 0
          CHECK (attempts BETWEEN 0 AND ${sql.lit(BRAIN_JOB_WORKER_CEILINGS.maxAttempts + 1)}),
        steps INTEGER NOT NULL DEFAULT 0 CHECK (steps BETWEEN 0 AND ${sql.lit(BRAIN_JOB_WORKER_CEILINGS.maxSteps)}),
        lease_owner TEXT CHECK (char_length(lease_owner) BETWEEN 1 AND 64),
        lease_expires_at TIMESTAMPTZ,
        cancel_requested BOOLEAN NOT NULL DEFAULT false,
        result JSONB CHECK (jsonb_typeof(result) = 'object'
          AND octet_length(result::text) <= ${sql.lit(BRAIN_JOB_LIMITS.summaryMaxBytes)}),
        error_code TEXT CHECK (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
        created_at TIMESTAMPTZ NOT NULL,
        started_at TIMESTAMPTZ,
        heartbeat_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (owner_id, scope_id, job_id),
        CHECK ((status = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
        CHECK ((status IN ('succeeded', 'failed', 'cancelled')) = (finished_at IS NOT NULL))
      )
    `.execute(trx);
    // At most one queued or running job per (scope, kind, target): the dedupe rule.
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS brain_jobs_active_slot ON brain_jobs (owner_id, scope_id, kind, target)
      WHERE status IN ('queued', 'running')
    `.execute(trx);
    // Claims (oldest queued first) and lease recovery.
    await sql`
      CREATE INDEX IF NOT EXISTS brain_jobs_active ON brain_jobs (owner_id, status, created_at)
      WHERE status IN ('queued', 'running')
    `.execute(trx);
    // Recent jobs of a scope, newest first.
    await sql`
      CREATE INDEX IF NOT EXISTS brain_jobs_recent ON brain_jobs (owner_id, scope_id, created_at DESC, job_id DESC)
    `.execute(trx);
  });
}
