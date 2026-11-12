import { sql } from 'kysely';
import type { PlatformDB } from '../db.js';

/**
 * Global free-tier ceilings (spec 2691 US4): total runtimes, running
 * runtimes, and daily funded spend. Each is checked and acted on under its
 * own transaction-scoped advisory lock, so concurrent platform instances
 * cannot both pass a ceiling. Separate keys keep the three from waiting on
 * each other and avoid lock-order cycles with the row locks each path takes.
 * Reaching a ceiling is a busy answer, never an error.
 */

export type CapacityCeiling = 'total_runtimes' | 'running_runtimes' | 'daily_funded_spend';

const LOCK_KEYS: Record<CapacityCeiling, string> = {
  // Unchanged from layer 2a so instances on either side of a rollout still exclude each other.
  total_runtimes: 'matrix:free-tier:runtime-capacity',
  running_runtimes: 'matrix:free-tier:running-capacity',
  daily_funded_spend: 'matrix:free-tier:daily-funded-spend',
};

/** Container statuses that hold compute and count against the running ceiling. */
export const COMPUTE_HOLDING_STATUSES = ['starting', 'running', 'quiescing'] as const;

type Executor = PlatformDB['executor'];

/** Must run inside a transaction; the lock is released when it ends. */
export async function lockCapacity(executor: Executor, ceiling: CapacityCeiling): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${LOCK_KEYS[ceiling]}, 0))`.execute(executor);
}

export async function countRunningContainers(executor: Executor): Promise<number> {
  const row = await executor.selectFrom('user_machines').select(sql<number>`count(*)::int`.as('n'))
    .where('substrate', '=', 'container').where('deleted_at', 'is', null)
    .where('status', 'in', [...COMPUTE_HOLDING_STATUSES]).executeTakeFirstOrThrow();
  return Number(row.n);
}

export function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/**
 * Today's funded spend of free runtimes, read from the funded reservation
 * ledger: settled work at its actual cost, active holds at their full hold,
 * expired holds at their hold because their cost is unknown, released holds
 * at nothing.
 */
export async function readDailyFundedSpend(executor: Executor, now: Date): Promise<number> {
  const result = await sql<{ spent: string | number }>`
    SELECT COALESCE(SUM(CASE
      WHEN r.status = 'settled' THEN COALESCE(r.actual_microusd, r.reserved_microusd)
      WHEN r.status = 'released' THEN COALESCE(r.actual_microusd, 0)
      ELSE GREATEST(r.reserved_microusd, COALESCE(r.actual_microusd, 0))
    END), 0) AS spent
    FROM ai_funded_usage_reservations r
    JOIN user_machines m ON m.machine_id = r.machine_id
    WHERE m.provisioning_class = 'free' AND r.created_at >= ${utcDayStart(now)}
  `.execute(executor);
  return Number(result.rows[0]?.spent ?? 0);
}

/**
 * Takes the daily spend lock and says whether a new free-runtime hold fits.
 * The caller inserts the reservation in the same transaction, so the lock
 * covers both the read and the write.
 */
export async function admitDailyFundedSpend(executor: Executor, input: {
  holdMicrousd: number; ceilingMicrousd: number; now: Date;
}): Promise<boolean> {
  await lockCapacity(executor, 'daily_funded_spend');
  return await readDailyFundedSpend(executor, input.now) + input.holdMicrousd <= input.ceilingMicrousd;
}
