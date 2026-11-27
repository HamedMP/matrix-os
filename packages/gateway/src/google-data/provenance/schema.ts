import { boundedProvenanceTransaction } from "./transaction.js";
import { sql, type Kysely } from "kysely";

/** Independent tables: host owns the injected pool and scheduling; this module never closes it. */
export async function migrateGoogleProvenance<DB>(db: Kysely<DB>) {
  await boundedProvenanceTransaction(db, async tx => {
    await sql`SELECT pg_advisory_xact_lock(551035503)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS google_copy_registry (
      id UUID PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('chat','session','import','attachment','derived')),
      entity_ref TEXT NOT NULL, content_hash TEXT NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
      origins JSONB NOT NULL CHECK(jsonb_typeof(origins)='array' AND jsonb_array_length(origins) BETWEEN 1 AND 32),
      revision INTEGER NOT NULL CHECK(revision > 0), retention_deadline TIMESTAMPTZ NOT NULL,
      retention_decision_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','purging','deleted')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(owner_id,kind,entity_ref))`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS google_copy_retention ON google_copy_registry(retention_deadline) WHERE state='active'`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS google_copy_owner ON google_copy_registry(owner_id)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS google_copy_purge_requests (
      id UUID PRIMARY KEY, owner_id TEXT NOT NULL, connection_id TEXT NOT NULL, request_key TEXT NOT NULL,
      archived_deleted INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(owner_id,request_key), UNIQUE(owner_id,connection_id))`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS google_copy_purge_keys (
      owner_id TEXT NOT NULL, request_key TEXT NOT NULL,
      request_id UUID NOT NULL REFERENCES google_copy_purge_requests(id), PRIMARY KEY(owner_id,request_key))`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS google_copy_purge_connection ON google_copy_purge_requests(owner_id,connection_id)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS google_copy_purge_jobs (
      id UUID PRIMARY KEY, copy_id UUID NOT NULL UNIQUE REFERENCES google_copy_registry(id), owner_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','leased','deleted','unresolved')),
      reason TEXT CHECK(reason IN ('missing_handler','modified','unavailable','retry_exhausted','timeout')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0), revision INTEGER NOT NULL DEFAULT 1,
      lease_token UUID, worker_id TEXT, lease_until TIMESTAMPTZ,
      next_attempt TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`.execute(tx);
    await sql`CREATE INDEX IF NOT EXISTS google_copy_purge_work ON google_copy_purge_jobs(state,next_attempt,lease_until)`.execute(tx);
    await sql`CREATE TABLE IF NOT EXISTS google_copy_purge_links (
      request_id UUID NOT NULL REFERENCES google_copy_purge_requests(id), job_id UUID NOT NULL REFERENCES google_copy_purge_jobs(id),
      PRIMARY KEY(request_id,job_id))`.execute(tx);
  });
}
