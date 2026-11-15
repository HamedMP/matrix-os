import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/**
 * Spec 2691 US4: per-owner object-store usage for container runtimes. The
 * usage row is the lock and the counter; the per-key ledger lets overwrites
 * and deletes adjust it exactly. `pending_until` marks an authorized write the
 * broker has not seen land, so an abandoned upload can be reconciled;
 * `signed_until` is when the last signed upload URL for the key expires.
 */
export async function migrateContainerLimits(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS runtime_storage_usage (
      clerk_user_id TEXT PRIMARY KEY,
      object_bytes BIGINT NOT NULL DEFAULT 0 CHECK (object_bytes >= 0),
      object_count INTEGER NOT NULL DEFAULT 0 CHECK (object_count >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS runtime_storage_objects (
      clerk_user_id TEXT NOT NULL REFERENCES runtime_storage_usage(clerk_user_id) ON DELETE CASCADE,
      object_key TEXT NOT NULL CHECK (length(object_key) BETWEEN 1 AND 1024),
      bytes BIGINT NOT NULL CHECK (bytes >= 0),
      counts_as_file BOOLEAN NOT NULL,
      reservation_id UUID NOT NULL,
      pending_until TIMESTAMPTZ,
      signed_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (clerk_user_id, object_key)
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_runtime_storage_objects_pending
    ON runtime_storage_objects (clerk_user_id, pending_until)
    WHERE pending_until IS NOT NULL
  `.execute(db);
}
