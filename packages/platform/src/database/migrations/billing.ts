import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/** Extracted verbatim from packages/platform/src/db.ts migrateSchema (S01 / T007). Order is preserved by migrate.ts. */
export async function migrateBilling(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS billing_customers (
      clerk_user_id TEXT PRIMARY KEY,
      stripe_customer_id TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS billing_subscriptions (
      stripe_subscription_id TEXT PRIMARY KEY,
      stripe_customer_id TEXT NOT NULL,
      clerk_user_id TEXT NOT NULL,
      runtime_slot TEXT NOT NULL,
      plan_slug TEXT NOT NULL,
      stripe_price_id TEXT NOT NULL,
      billing_interval TEXT,
      price_unit_amount_minor INTEGER,
      price_currency TEXT,
      price_interval_count INTEGER,
      price_quantity INTEGER,
      status TEXT NOT NULL,
      current_period_end TEXT,
      grace_period_ends_at TEXT,
      trial_started_at TEXT,
      trial_ends_at TEXT,
      trial_converted_at TEXT,
      first_trial_payment_failed_at TEXT,
      latest_event_created_at TEXT NOT NULL,
      latest_event_id TEXT NOT NULL,
      latest_invoice_event_created_at TEXT,
      latest_invoice_event_id TEXT,
      updated_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`ALTER TABLE billing_subscriptions ALTER COLUMN billing_interval DROP NOT NULL`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS price_unit_amount_minor INTEGER`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS price_currency TEXT`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS price_interval_count INTEGER`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS price_quantity INTEGER`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS trial_started_at TEXT`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS trial_ends_at TEXT`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS trial_converted_at TEXT`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS first_trial_payment_failed_at TEXT`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS latest_invoice_event_created_at TEXT`.execute(db);
  await sql`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS latest_invoice_event_id TEXT`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_user_slot ON billing_subscriptions(clerk_user_id, runtime_slot, latest_event_created_at DESC)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_customer ON billing_subscriptions(stripe_customer_id)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS billing_entitlements (
      clerk_user_id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      plan_slug TEXT NOT NULL,
      status TEXT NOT NULL,
      max_runtime_slots INTEGER NOT NULL,
      included_runtime_slots INTEGER NOT NULL,
      addon_runtime_slots INTEGER NOT NULL,
      default_server_type TEXT NOT NULL,
      allowed_server_types TEXT NOT NULL,
      stripe_subscription_id TEXT,
      stripe_price_id TEXT,
      billing_interval TEXT,
      grace_period_ends_at TEXT,
      effective_from TEXT NOT NULL,
      effective_until TEXT,
      updated_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_billing_entitlements_status ON billing_entitlements(status)`.execute(db);
  await sql`ALTER TABLE billing_entitlements ADD COLUMN IF NOT EXISTS billing_interval TEXT`.execute(db);
  await sql`ALTER TABLE billing_entitlements ADD COLUMN IF NOT EXISTS trial_started_at TEXT`.execute(db);
  await sql`ALTER TABLE billing_entitlements ADD COLUMN IF NOT EXISTS trial_ends_at TEXT`.execute(db);
  await sql`ALTER TABLE billing_entitlements ADD COLUMN IF NOT EXISTS trial_converted_at TEXT`.execute(db);
  await sql`ALTER TABLE billing_entitlements ADD COLUMN IF NOT EXISTS first_trial_payment_failed_at TEXT`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_billing_entitlements_subscription ON billing_entitlements(stripe_subscription_id)`.execute(db);

  // Existing production subscriptions predate runtime-slot metadata. Current
  // fleet evidence guarantees all billable machines are primary; this
  // idempotent backfill keeps them authorized before their next Stripe event.
  await sql`
    INSERT INTO billing_subscriptions (
      stripe_subscription_id,
      stripe_customer_id,
      clerk_user_id,
      runtime_slot,
      plan_slug,
      stripe_price_id,
      billing_interval,
      status,
      current_period_end,
      grace_period_ends_at,
      latest_event_created_at,
      latest_event_id,
      updated_at
    )
    SELECT
      e.stripe_subscription_id,
      c.stripe_customer_id,
      e.clerk_user_id,
      'primary',
      e.plan_slug,
      e.stripe_price_id,
      NULL,
      e.status,
      NULL,
      e.grace_period_ends_at,
      e.updated_at,
      'legacy_backfill',
      e.updated_at
    FROM billing_entitlements e
    JOIN billing_customers c ON c.clerk_user_id = e.clerk_user_id
    WHERE e.source = 'stripe'
      AND e.stripe_subscription_id IS NOT NULL
      AND e.stripe_price_id IS NOT NULL
    ON CONFLICT (stripe_subscription_id) DO NOTHING
  `.execute(db);
  await sql`
    UPDATE billing_entitlements entitlements
    SET max_runtime_slots = 1,
        included_runtime_slots = 1,
        addon_runtime_slots = 0
    WHERE entitlements.source = 'stripe'
      AND EXISTS (
        SELECT 1
        FROM billing_subscriptions subscriptions
        WHERE subscriptions.clerk_user_id = entitlements.clerk_user_id
          AND subscriptions.latest_event_id = 'legacy_backfill'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM billing_subscriptions subscriptions
        WHERE subscriptions.clerk_user_id = entitlements.clerk_user_id
          AND subscriptions.latest_event_id <> 'legacy_backfill'
      )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS billing_entitlement_overrides (
      id TEXT PRIMARY KEY,
      clerk_user_id TEXT NOT NULL,
      plan_slug TEXT NOT NULL,
      status TEXT NOT NULL,
      max_runtime_slots INTEGER NOT NULL,
      included_runtime_slots INTEGER NOT NULL,
      addon_runtime_slots INTEGER NOT NULL,
      default_server_type TEXT NOT NULL,
      allowed_server_types TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_by TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_billing_overrides_user ON billing_entitlement_overrides(clerk_user_id, revoked_at, expires_at)`.execute(db);

  const unsupportedExistingComputers = await sql<{ count: string }>`
    SELECT COUNT(*)::TEXT AS count
    FROM user_machines m
    WHERE m.deleted_at IS NULL
      AND m.provisioning_class = 'customer'
      AND m.runtime_slot <> 'primary'
      AND m.provisioned_at <= '2026-07-21T16:28:00.000Z'
      AND NOT EXISTS (
        SELECT 1
        FROM billing_subscriptions s
        WHERE s.clerk_user_id = m.clerk_user_id
          AND s.runtime_slot = m.runtime_slot
      )
      AND NOT EXISTS (
        SELECT 1
        FROM billing_entitlement_overrides o
        WHERE o.clerk_user_id = m.clerk_user_id
          AND o.revoked_at IS NULL
          AND (o.expires_at IS NULL OR o.expires_at::TIMESTAMPTZ > NOW())
      )
  `.execute(db);
  if (Number(unsupportedExistingComputers.rows[0]?.count ?? '0') > 0) {
    throw new Error('billing subscription migration blocked by existing unassigned customer computers');
  }

  await sql`
    CREATE TABLE IF NOT EXISTS billing_webhook_events (
      stripe_event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      created_at_from_stripe TEXT NOT NULL,
      processed_at TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS billing_runtime_actions (
      id TEXT PRIMARY KEY,
      machine_id TEXT NOT NULL REFERENCES user_machines(machine_id) ON UPDATE CASCADE,
      stripe_subscription_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('suspend', 'resume')),
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      execute_after TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      claimed_at TEXT,
      lease_expires_at TEXT,
      cancel_requested_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `.execute(db);
  await sql`ALTER TABLE billing_runtime_actions ADD COLUMN IF NOT EXISTS cancel_requested_at TEXT`.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_runtime_actions_active
    ON billing_runtime_actions(machine_id, action)
    WHERE status IN ('queued', 'running')
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_billing_runtime_actions_dispatch
    ON billing_runtime_actions(status, execute_after, lease_expires_at)
  `.execute(db);
}
