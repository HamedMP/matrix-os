import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/**
 * Spec 2691 (ENG-520; ported from PR #3414): free-tier invites, one row per
 * invited owner. `consumed_at` is set by the single statement that redeems the
 * invite, so one invite admits at most one free owner. Free runtimes are metal
 * VMs; the container-only provisioning-class check from #3414 is not ported.
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
}

/**
 * ENG-520 launch guard: a paid subscription that lands for a free owner is
 * never projected; it is queued here for cancel and refund of the payments
 * made since `refund_paid_since` (free admission). `generation` counts re-arms
 * (a later invoice event), so a sweep that held the row never marks a
 * re-armed row done. Keyed by the
 * Stripe subscription only (no owner identity), so account deletion has
 * nothing to erase and a pending refund survives it.
 */
export async function migrateFreeOwnerCompensations(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS billing_free_owner_compensations (
      stripe_subscription_id TEXT PRIMARY KEY CHECK (stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,255}$'),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'awaiting_settlement', 'done')),
      refund_paid_since TIMESTAMPTZ NOT NULL,
      generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      lease_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_billing_free_owner_compensations_pending
    ON billing_free_owner_compensations (created_at) WHERE status <> 'done'
  `.execute(db);
}
