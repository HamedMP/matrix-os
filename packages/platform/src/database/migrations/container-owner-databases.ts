import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/**
 * Spec 2691: one database and login role per container-runtime owner on the
 * shared owner cluster. Names are opaque because every owner can read the
 * cluster's role and database catalogs. The password is never stored here.
 */
export async function migrateContainerOwnerDatabases(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS container_owner_databases (
      clerk_user_id TEXT PRIMARY KEY,
      database_name TEXT NOT NULL UNIQUE CHECK (database_name ~ '^mxo_[a-z2-7]{26}$'),
      role_name TEXT NOT NULL UNIQUE CHECK (role_name ~ '^mxr_[a-z2-7]{26}$'),
      connection_limit INTEGER NOT NULL DEFAULT 5 CHECK (connection_limit BETWEEN 1 AND 20),
      size_limit_bytes BIGINT NOT NULL CHECK (size_limit_bytes > 0),
      size_measured_at TIMESTAMPTZ,
      size_bytes BIGINT CHECK (size_bytes IS NULL OR size_bytes >= 0),
      state TEXT NOT NULL CHECK (state IN ('active', 'fenced', 'deleting')),
      password_epoch INTEGER NOT NULL CHECK (password_epoch >= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at TIMESTAMPTZ
    )
  `.execute(db);
}
