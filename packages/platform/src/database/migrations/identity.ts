import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/** Extracted verbatim from packages/platform/src/db.ts migrateSchema (S01 / T007). Order is preserved by migrate.ts. */
export async function migrateIdentity(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      clerk_id             TEXT UNIQUE NOT NULL,
      handle               TEXT UNIQUE NOT NULL,
      display_name         TEXT NOT NULL,
      email                TEXT NOT NULL,
      container_id         TEXT UNIQUE NOT NULL,
      container_version    TEXT,
      plan                 TEXT NOT NULL DEFAULT 'free',
      status               TEXT NOT NULL DEFAULT 'active',
      pipedream_external_id TEXT,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_users_pipedream_ext_id ON users(pipedream_external_id)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS containers (
      handle TEXT PRIMARY KEY,
      clerk_user_id TEXT UNIQUE NOT NULL,
      container_id TEXT,
      port INTEGER NOT NULL,
      shell_port INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'provisioning',
      created_at TEXT NOT NULL,
      last_active TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_containers_status ON containers(status)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_containers_clerk ON containers(clerk_user_id)`.execute(db);
}
