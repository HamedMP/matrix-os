import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/**
 * Spec 2691: free-tier invites, one row per invited owner. `consumed_at` is
 * set by the single statement that redeems the invite, so one invite yields
 * at most one free runtime. A container runtime is always provisioning class
 * `free`; NOT VALID keeps an unexpected legacy row from blocking startup while
 * Postgres still checks every new or updated row.
 */
export async function migrateFreeTier(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS free_tier_invites (
      clerk_user_id TEXT PRIMARY KEY CHECK (clerk_user_id ~ '^user_[A-Za-z0-9]{1,128}$'),
      invited_by TEXT NOT NULL CHECK (invited_by ~ '^[A-Za-z0-9._@:-]{1,128}$'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      consumed_at TIMESTAMPTZ
    )
  `.execute(db);
  await sql`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'user_machines'::regclass
          AND conname = 'user_machines_container_class_check'
      ) THEN
        ALTER TABLE user_machines
          ADD CONSTRAINT user_machines_container_class_check
          CHECK (substrate <> 'container' OR provisioning_class = 'free') NOT VALID;
      END IF;
    END
    $$
  `.execute(db);
}
