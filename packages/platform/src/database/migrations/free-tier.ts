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
 * ENG-520 launch guard: compensation for a paid Checkout session that a free
 * owner completed anyway, one row per blocked session we recorded as their
 * checkout attempt. Only that session's own payment is refunded; `refund_id`
 * and `refund_status` track the refund until Stripe reports it succeeded.
 * `generation` counts re-arms so a sweep holding the row never overwrites a
 * newer event. No owner identity is stored, so account deletion has nothing
 * to erase and a pending refund survives it.
 */
export async function migrateFreeOwnerCompensations(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS billing_free_owner_compensations (
      stripe_checkout_session_id TEXT PRIMARY KEY CHECK (stripe_checkout_session_id ~ '^cs_[A-Za-z0-9_]{1,255}$'),
      checkout_attempt_id TEXT NOT NULL CHECK (length(checkout_attempt_id) BETWEEN 1 AND 128),
      stripe_subscription_id TEXT CHECK (stripe_subscription_id ~ '^sub_[A-Za-z0-9]{1,255}$'),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'awaiting_settlement', 'refund_pending', 'refund_failed', 'done')),
      refund_id TEXT CHECK (refund_id ~ '^re_[A-Za-z0-9]{1,255}$'),
      refund_status TEXT CHECK (refund_status IN ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')),
      refund_round INTEGER NOT NULL DEFAULT 0 CHECK (refund_round >= 0),
      generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      lease_until TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ
    )
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_billing_free_owner_compensations_open
    ON billing_free_owner_compensations (created_at) WHERE status <> 'done'
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_billing_free_owner_compensations_subscription
    ON billing_free_owner_compensations (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL
  `.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_free_owner_compensations_refund
    ON billing_free_owner_compensations (refund_id) WHERE refund_id IS NOT NULL
  `.execute(db);
}
