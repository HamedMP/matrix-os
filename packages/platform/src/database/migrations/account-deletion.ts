import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

export async function migrateAccountDeletion(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS account_deletion_jobs (
      owner_hash TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('scheduled', 'processing', 'completed', 'cancelled')),
      encrypted_context TEXT,
      accounting_summary JSONB,
      due_at TEXT NOT NULL,
      next_attempt_at TEXT NOT NULL,
      next_step INTEGER NOT NULL DEFAULT 0 CHECK (next_step BETWEEN 0 AND 7),
      billing_stopped BOOLEAN NOT NULL DEFAULT FALSE,
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,
      lease_expires_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `.execute(db);
  await sql`ALTER TABLE account_deletion_jobs ADD COLUMN IF NOT EXISTS accounting_summary JSONB`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_account_deletion_dispatch
    ON account_deletion_jobs (status, next_attempt_at, lease_expires_at)`.execute(db);
}
