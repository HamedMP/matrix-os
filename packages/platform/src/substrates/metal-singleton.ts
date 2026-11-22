import { sql } from 'kysely';
import type { PlatformDB } from '../db.js';

/**
 * Cluster-wide single flight for metal background passes (spec 2691,
 * ENG-520). The dedicated worker runs as one Cloud Run instance, but a deploy
 * briefly overlaps two revisions; a pass runs only while its transaction holds
 * a Postgres advisory lock, and another instance skips the pass instead of
 * waiting. The lock is transaction-scoped, so a crashed worker releases it.
 * The pass's own writes use separate connections (each a guarded statement);
 * the lock transaction only holds the lock.
 */
export const METAL_MAINTENANCE_LOCK_KEY = 2_691_520_001;
export const METAL_SLEEPER_LOCK_KEY = 2_691_520_002;

export async function runAsSingleton(db: PlatformDB, key: number, run: () => Promise<void>): Promise<boolean> {
  await db.ready;
  return db.kysely.transaction().execute(async (trx) => {
    const result = await sql<{ locked: boolean }>`SELECT pg_try_advisory_xact_lock(${key}::bigint) AS locked`.execute(trx);
    if (result.rows[0]?.locked !== true) return false;
    await run();
    return true;
  });
}
