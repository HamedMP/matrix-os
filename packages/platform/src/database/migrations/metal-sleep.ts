import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/**
 * Spec 2691 (ENG-520 Task P6): idle sleep and scheduled wake for free metal
 * runtimes. `awake_since` is stamped whenever a metal runtime becomes running,
 * `next_wake_at` is when the sleeper must wake a sleeping runtime (60 s before
 * its next scheduled job), and `idle_guard_at` records when the 6 h idle guard
 * suspended a runtime that still reported work. The partial index serves the
 * sleeper's wake scan.
 */
export async function migrateMetalSleep(db: PlatformMigrationExecutor): Promise<void> {
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS next_wake_at TIMESTAMPTZ`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS awake_since TIMESTAMPTZ`.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS idle_guard_at TIMESTAMPTZ`.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_user_machines_metal_next_wake
    ON user_machines (next_wake_at)
    WHERE substrate = 'metal' AND next_wake_at IS NOT NULL AND deleted_at IS NULL
  `.execute(db);
}
