import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/** Extracted verbatim from packages/platform/src/db.ts migrateSchema (S01 / T007). Order is preserved by migrate.ts. */
export async function migrateCheckout(db: PlatformMigrationExecutor): Promise<void> {
  // Onboarding journey (spec 092): server-owned signup-to-ready state. Schema is
  // uniformly TEXT/uuid/ISO-string to match the rest of this file (no jsonb/serial).
  await sql`
    CREATE TABLE IF NOT EXISTS billing_checkout_attempts (
      id TEXT PRIMARY KEY,
      clerk_user_id TEXT NOT NULL,
      stripe_session_id TEXT UNIQUE,
      checkout_url TEXT,
      runtime_slot TEXT NOT NULL DEFAULT 'primary',
      plan_slug TEXT,
      billing_interval TEXT,
      region_slug TEXT,
      server_type TEXT,
      trial_period_days INTEGER,
      developer_tools TEXT NOT NULL DEFAULT '["codex","claude-code","opencode","pi"]',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `.execute(db);
  await sql`ALTER TABLE billing_checkout_attempts ALTER COLUMN stripe_session_id DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS checkout_url TEXT`.execute(db);
  await sql`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS developer_tools TEXT NOT NULL DEFAULT '["codex","claude-code","opencode","pi"]'`.execute(db);
  await sql`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS runtime_slot TEXT NOT NULL DEFAULT 'primary'`.execute(db);
  await sql`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS plan_slug TEXT`.execute(db);
  await sql`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS billing_interval TEXT`.execute(db);
  await sql`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS region_slug TEXT`.execute(db);
  await sql`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS server_type TEXT`.execute(db);
  await sql`ALTER TABLE billing_checkout_attempts ADD COLUMN IF NOT EXISTS trial_period_days INTEGER`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_checkout_attempts_clerk_created ON billing_checkout_attempts(clerk_user_id, created_at)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_checkout_attempts_clerk_slot_created ON billing_checkout_attempts(clerk_user_id, runtime_slot, created_at)`.execute(db);
  await sql`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY clerk_user_id, runtime_slot
        ORDER BY created_at DESC, id DESC
      ) AS row_number
      FROM billing_checkout_attempts
      WHERE status IN ('creating', 'open')
    )
    UPDATE billing_checkout_attempts attempts
    SET status = 'abandoned', resolved_at = COALESCE(attempts.resolved_at, attempts.created_at)
    FROM ranked
    WHERE attempts.id = ranked.id AND ranked.row_number > 1
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_attempts_active_slot
    ON billing_checkout_attempts(clerk_user_id, runtime_slot)
    WHERE status IN ('creating', 'open')
  `.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS prebilling_provisioning_intents (
      id TEXT PRIMARY KEY,
      checkout_attempt_id TEXT NOT NULL UNIQUE REFERENCES billing_checkout_attempts(id) ON DELETE CASCADE,
      clerk_user_id TEXT NOT NULL,
      runtime_slot TEXT NOT NULL,
      plan_slug TEXT NOT NULL,
      billing_interval TEXT NOT NULL,
      server_type TEXT NOT NULL,
      region_slug TEXT NOT NULL,
      developer_tools TEXT NOT NULL,
      state TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      machine_id TEXT UNIQUE REFERENCES user_machines(machine_id) ON UPDATE CASCADE,
      stripe_session_id TEXT,
      stripe_session_expires_at TEXT,
      lease_expires_at TEXT,
      reserved_hourly_cost_micros BIGINT NOT NULL DEFAULT 0,
      cleanup_claimed_at TEXT,
      cleanup_lease_expires_at TEXT,
      ready_at TEXT,
      payment_confirmed_at TEXT,
      authorized_at TEXT,
      cleaned_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`ALTER TABLE prebilling_provisioning_intents ADD COLUMN IF NOT EXISTS payment_confirmed_at TEXT`.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prebilling_intents_active_owner_slot
    ON prebilling_provisioning_intents(clerk_user_id, runtime_slot)
    WHERE state IN ('awaiting_checkout', 'preparing', 'ready_waiting_for_billing', 'payment_settling', 'preparation_failed', 'preparation_deferred', 'cleanup_pending')
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prebilling_intents_stripe_session
    ON prebilling_provisioning_intents(stripe_session_id)
    WHERE stripe_session_id IS NOT NULL
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_prebilling_intents_cleanup ON prebilling_provisioning_intents(state, lease_expires_at)`.execute(db);
  await sql`
    CREATE TABLE IF NOT EXISTS billing_trial_accounts (
      clerk_user_id TEXT PRIMARY KEY,
      trial_checkout_attempt_id TEXT UNIQUE REFERENCES billing_checkout_attempts(id) ON DELETE SET NULL,
      consumed_at TEXT,
      updated_at TEXT NOT NULL
    )
  `.execute(db);
}
