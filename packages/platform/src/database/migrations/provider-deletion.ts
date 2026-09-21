import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/** Extracted verbatim from packages/platform/src/db.ts migrateSchema (S01 / T007). Order is preserved by migrate.ts. */
export async function migrateProviderDeletion(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS provider_deletion_queue (
      id TEXT PRIMARY KEY,
      provider_server_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      machine_id TEXT,
      handle TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_error TEXT,
      completed_at TEXT
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_provider_deletion_queue_pending
    ON provider_deletion_queue(next_attempt_at)
    WHERE completed_at IS NULL
  `.execute(db);
  await sql`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY provider_server_id ORDER BY created_at, id
      ) AS ordinal
      FROM provider_deletion_queue
      WHERE completed_at IS NULL
    )
    UPDATE provider_deletion_queue
    SET completed_at = created_at,
        last_error = COALESCE(last_error, 'deduplicated provider deletion')
    WHERE id IN (SELECT id FROM ranked WHERE ordinal > 1)
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_deletion_queue_server_active
    ON provider_deletion_queue(provider_server_id)
    WHERE completed_at IS NULL
  `.execute(db);
}
