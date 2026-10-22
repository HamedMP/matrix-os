import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

export async function migrateSubscriptionAiCredit(db: PlatformMigrationExecutor): Promise<void> {
  await sql`CREATE TABLE IF NOT EXISTS ai_subscription_credit_terms (
    subscription_id TEXT PRIMARY KEY REFERENCES billing_subscriptions(stripe_subscription_id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL, runtime_slot TEXT NOT NULL, anchor_at TEXT NOT NULL,
    observed_plan_slug TEXT NOT NULL, floor_cycle_start TEXT NOT NULL,
    floor_microusd BIGINT NOT NULL CHECK (floor_microusd >= 0), updated_at TEXT NOT NULL
  )`.execute(db);
  await sql`CREATE TABLE IF NOT EXISTS ai_subscription_credit_payments (
    invoice_id TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL REFERENCES billing_subscriptions(stripe_subscription_id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL, plan_slug TEXT NOT NULL,
    paid_from TEXT NOT NULL, paid_until TEXT NOT NULL CHECK (paid_until > paid_from), created_at TEXT NOT NULL
  )`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_ai_subscription_credit_paid
    ON ai_subscription_credit_payments(subscription_id, owner_id, paid_until)`.execute(db);
  // The owner's cycle survives computer replacement; deletion of their billing
  // identity erases it, together with the other owner-controlled financial data.
  await sql`CREATE TABLE IF NOT EXISTS ai_subscription_credit_cycles (
    owner_id TEXT NOT NULL REFERENCES billing_customers(clerk_user_id) ON DELETE CASCADE,
    runtime_slot TEXT NOT NULL, cycle_start TEXT NOT NULL, cycle_end TEXT NOT NULL CHECK (cycle_end > cycle_start),
    subscription_id TEXT NOT NULL,
    entitlement_microusd BIGINT NOT NULL CHECK (entitlement_microusd >= 0),
    legacy_offset_microusd BIGINT NOT NULL CHECK (legacy_offset_microusd >= 0), updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, runtime_slot, cycle_start)
  )`.execute(db);
}
