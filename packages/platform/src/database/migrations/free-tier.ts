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
