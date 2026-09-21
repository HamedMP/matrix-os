import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/** Extracted verbatim from packages/platform/src/db.ts migrateSchema (S01 / T007). Order is preserved by migrate.ts. */
export async function migrateOnboarding(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS onboarding_first_run (
      clerk_user_id TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL,
      goal TEXT,
      steps TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS onboarding_journey_events (
      id TEXT PRIMARY KEY,
      clerk_user_id TEXT NOT NULL,
      from_phase TEXT,
      to_phase TEXT NOT NULL,
      detail TEXT,
      at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_journey_events_clerk_at ON onboarding_journey_events(clerk_user_id, at)`.execute(db);
}
