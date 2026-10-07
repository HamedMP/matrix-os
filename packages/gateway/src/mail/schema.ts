import { sql, type Kysely } from "kysely";
import { mailTransaction } from "./reading.js";

// Metadata is exclusively owner Postgres. Payload files are immutable artifacts.
export async function bootstrapMailArchive(db: Kysely<unknown>): Promise<void> {
  await mailTransaction(db, async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('mail_archive_v1'))`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS mail_sources (
      owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 256),
      account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 256),
      provider TEXT NOT NULL CHECK(provider = 'gmail'), connection_id TEXT NOT NULL,
      email TEXT NOT NULL, account_label TEXT NOT NULL, source_group TEXT NOT NULL CHECK(source_group IN ('work','personal')),
      namespace TEXT NOT NULL CHECK(namespace ~ '^[a-f0-9]{64}$'), quota_bytes BIGINT NOT NULL CHECK(quota_bytes > 0),
      used_bytes BIGINT NOT NULL DEFAULT 0 CHECK(used_bytes >= 0 AND used_bytes <= quota_bytes),
      cursor TEXT, revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
      PRIMARY KEY(owner_id, account_id), UNIQUE(owner_id, provider, connection_id)
    )`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS mail_usage (
      owner_id TEXT NOT NULL, account_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('connectorCalls','messageRetrievals','reusedBodies','aiClassificationCalls','classificationReuse','get_profile','search','list_messages','list_history','get_metadata','get_message','get_message_summary','modify_message')),
      count BIGINT NOT NULL CHECK(count BETWEEN 0 AND 9007199254740991),
      PRIMARY KEY(owner_id,account_id,kind),
      FOREIGN KEY(owner_id,account_id) REFERENCES mail_sources(owner_id,account_id)
    )`.execute(trx);
    await sql`ALTER TABLE mail_sources ADD COLUMN IF NOT EXISTS paused BOOLEAN NOT NULL DEFAULT false`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS mail_messages (
      id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, account_id TEXT NOT NULL, message_id TEXT NOT NULL,
      metadata JSONB NOT NULL, object JSONB, size_bytes BIGINT NOT NULL CHECK(size_bytes >= 0),
      received_at TIMESTAMPTZ NOT NULL, deleted_at TIMESTAMPTZ, revision INTEGER NOT NULL DEFAULT 1,
      correction TEXT CHECK(correction IN ('newsletter','not_newsletter')),
      PRIMARY KEY(owner_id, account_id, message_id),
      FOREIGN KEY(owner_id, account_id) REFERENCES mail_sources(owner_id, account_id)
    )`.execute(trx);
    await sql`CREATE INDEX IF NOT EXISTS mail_messages_range ON mail_messages(owner_id, account_id, received_at, id) WHERE deleted_at IS NULL`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS mail_consumer_grants (
      owner_id TEXT NOT NULL, account_id TEXT NOT NULL, app_id TEXT NOT NULL,
      range_from TIMESTAMPTZ, range_until TIMESTAMPTZ, purpose TEXT NOT NULL,
      revoked BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY(owner_id, account_id, app_id),
      FOREIGN KEY(owner_id, account_id) REFERENCES mail_sources(owner_id, account_id),
      CHECK(range_from IS NULL OR range_until IS NULL OR range_from <= range_until)
    )`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS mail_reading (
      owner_id TEXT NOT NULL, account_id TEXT NOT NULL, app_id TEXT NOT NULL, message_id TEXT NOT NULL,
      saved BOOLEAN NOT NULL, is_read BOOLEAN NOT NULL, progress DOUBLE PRECISION NOT NULL CHECK(progress BETWEEN 0 AND 1),
      revision INTEGER NOT NULL CHECK(revision > 0),
      PRIMARY KEY(owner_id, account_id, app_id, message_id),
      FOREIGN KEY(owner_id, account_id, message_id) REFERENCES mail_messages(owner_id, account_id, message_id)
    )`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS mail_sync_jobs (
      id TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, account_id TEXT NOT NULL,
      range_from TIMESTAMPTZ NOT NULL, range_until TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','running','completed')),
      token TEXT, worker_id TEXT, lease_until TIMESTAMPTZ, checkpoint JSONB,
      PRIMARY KEY(owner_id, account_id), CHECK(range_from <= range_until),
      FOREIGN KEY(owner_id, account_id) REFERENCES mail_sources(owner_id, account_id)
    )`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS mail_classifications (
      owner_id TEXT NOT NULL, account_id TEXT NOT NULL, message_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'), context_kind TEXT NOT NULL,
      recipe TEXT NOT NULL, model_policy_version TEXT NOT NULL, result JSONB NOT NULL,
      PRIMARY KEY(owner_id, account_id, message_id, fingerprint, context_kind, recipe, model_policy_version),
      FOREIGN KEY(owner_id, account_id, message_id) REFERENCES mail_messages(owner_id, account_id, message_id)
    )`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS mail_classification_deferrals (
      owner_id TEXT NOT NULL, account_id TEXT NOT NULL, message_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
      context_kind TEXT NOT NULL CHECK(context_kind IN ('snippet','verified')),
      recipe TEXT NOT NULL CHECK(recipe = 'email-triage-v1'), model_policy_version TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('unknown','result_expired')),
      PRIMARY KEY(owner_id,account_id,message_id,fingerprint,context_kind,recipe,model_policy_version),
      FOREIGN KEY(owner_id,account_id,message_id) REFERENCES mail_messages(owner_id,account_id,message_id)
    )`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS mail_object_leases (
      namespace TEXT NOT NULL, digest TEXT NOT NULL, token TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(namespace, digest, token)
    )`.execute(trx);
    await sql`CREATE INDEX IF NOT EXISTS mail_object_lease_expiry ON mail_object_leases(expires_at)`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS mail_cleanup_plans (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, account_id TEXT NOT NULL, payload JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      FOREIGN KEY(owner_id,account_id) REFERENCES mail_sources(owner_id,account_id)
    )`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS mail_cleanup_operations (
      id TEXT PRIMARY KEY, plan_id TEXT NOT NULL UNIQUE REFERENCES mail_cleanup_plans(id),
      owner_id TEXT NOT NULL, account_id TEXT NOT NULL,
      FOREIGN KEY(owner_id,account_id) REFERENCES mail_sources(owner_id,account_id)
    )`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS mail_cleanup_operation_entries (
      operation_id TEXT NOT NULL REFERENCES mail_cleanup_operations(id), message_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('planned','dispatching','unknown','confirmed','skipped','undo_pending','undone')),
      payload JSONB NOT NULL, PRIMARY KEY(operation_id,message_id)
    )`.execute(trx);
  });
}
