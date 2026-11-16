import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/**
 * Spec 2691 decision D3: billed compute per free owner per UTC month. One row
 * per owner and month holds closed time; a running unit's open interval lives
 * on its user_machines row (`metered_since`) and is closed into this row in
 * the same transaction as the transition that ends it. `compute_mode` marks
 * an export-only start, whose time is counted apart from billed time.
 */
export async function migrateRuntimeCompute(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS runtime_compute_usage (
      clerk_user_id TEXT NOT NULL,
      month_start DATE NOT NULL,
      billed_ms BIGINT NOT NULL DEFAULT 0 CHECK (billed_ms >= 0),
      export_ms BIGINT NOT NULL DEFAULT 0 CHECK (export_ms >= 0),
      export_wakes INTEGER NOT NULL DEFAULT 0 CHECK (export_wakes >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (clerk_user_id, month_start)
    )
  `.execute(db);
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS metered_since TIMESTAMPTZ`.execute(db);
  // The provider expiry of the unit serving the row: no interval is metered past it.
  await sql`ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS unit_expires_at TIMESTAMPTZ`.execute(db);
  await sql`
    ALTER TABLE user_machines ADD COLUMN IF NOT EXISTS compute_mode TEXT NOT NULL DEFAULT 'full'
      CONSTRAINT user_machines_compute_mode_check CHECK (compute_mode IN ('full', 'export_only'))
  `.execute(db);
  // Units already holding compute when metering ships start their interval at their recorded start.
  await sql`
    UPDATE user_machines SET metered_since = COALESCE(started_at, now())
    WHERE substrate = 'container' AND deleted_at IS NULL AND metered_since IS NULL
      AND status IN ('starting', 'running', 'quiescing')
  `.execute(db);
}
