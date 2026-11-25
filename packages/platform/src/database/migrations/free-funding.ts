import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/**
 * Spec 2691 (ENG-520 Task P7): free Matrix AI funding. Every free funded
 * admission sums today's free reservations under one global advisory lock
 * (`readDailyFundedSpend`); this index bounds that read to today's rows
 * instead of the whole reservation table. `free_funded` records, when the
 * reservation is created, that the free plan funded it, so an owner who
 * upgrades later the same day still has their free spending counted.
 */
export async function migrateFreeFunding(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    ALTER TABLE ai_funded_usage_reservations
    ADD COLUMN IF NOT EXISTS free_funded BOOLEAN NOT NULL DEFAULT false
  `.execute(db);
  await sql`
    ALTER TABLE ai_funded_runtime_policies
    ADD COLUMN IF NOT EXISTS uses_free_model_default BOOLEAN NOT NULL DEFAULT false
  `.execute(db);
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_funded_usage_reservations_created
    ON ai_funded_usage_reservations (created_at)
  `.execute(db);
}
