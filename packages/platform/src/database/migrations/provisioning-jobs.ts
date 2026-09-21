import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/** Extracted verbatim from packages/platform/src/db.ts migrateSchema (S01 / T007). Order is preserved by migrate.ts. */
export async function migrateProvisioningJobs(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS provisioning_jobs (
      job_id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL UNIQUE REFERENCES user_machines(machine_id) ON UPDATE CASCADE,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      claimed_at TEXT,
      lease_expires_at TEXT,
      encrypted_payload TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      authorization_basis TEXT NOT NULL DEFAULT 'billing_entitlement',
      prebilling_intent_id TEXT
    )
  `.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS target_bundle_version TEXT`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS target_bundle_sha256 TEXT`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS image_source TEXT NOT NULL DEFAULT 'unresolved'`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS snapshot_id TEXT`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS snapshot_lease_id TEXT`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS snapshot_create_intent_id TEXT`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS activation_step TEXT NOT NULL DEFAULT 'selecting'`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS provider_create_action_id BIGINT`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS fallback_reason TEXT`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS authorization_basis TEXT NOT NULL DEFAULT 'billing_entitlement'`.execute(db);
  await sql`ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS prebilling_intent_id TEXT`.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_provisioning_jobs_dispatch
    ON provisioning_jobs(status, available_at, lease_expires_at)
  `.execute(db);
}
