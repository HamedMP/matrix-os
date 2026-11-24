import { sql } from 'kysely';
import type { PlatformMigrationExecutor } from '../migration-types.js';

/**
 * Spec 2691 (ENG-520 Task P7): free Matrix AI funding. Every free funded
 * admission sums today's free reservations under one global advisory lock
 * (`readDailyFundedSpend`); this index bounds that read to today's rows
 * instead of the whole reservation table.
 */
export async function migrateFreeFunding(db: PlatformMigrationExecutor): Promise<void> {
  await sql`
    CREATE INDEX IF NOT EXISTS idx_ai_funded_usage_reservations_created
    ON ai_funded_usage_reservations (created_at)
  `.execute(db);
}
