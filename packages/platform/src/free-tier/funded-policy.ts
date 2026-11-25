import { FREE_MANAGED_MODEL_ID } from '@matrix-os/contracts';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { PlatformDB } from '../db.js';
import { AiFundedPolicyError } from '../ai-funded-policy-errors.js';

/**
 * Funded AI for free metal runtimes (spec 2691 D2, ENG-520 Task P7; ported
 * from PR #3437): the once-per-owner starter credit plus a $5 allowance each
 * UTC calendar month, on the managed default model only, under a global daily
 * spend ceiling. The allowance is an ordinary promotional grant that expires
 * when its month ends, so admission, holds and settlement stay on the one
 * funded reservation path and ledger. Own-account sources never come through here.
 */

export { FREE_MANAGED_MODEL_ID };
export const FREE_MONTHLY_ALLOWANCE_MICROUSD = 5_000_000;
const ALLOWANCE_SOURCE = 'matrix-free-monthly-allowance';
const ALLOWANCE_ENTRY_PREFIX = 'free-monthly:';
const DAILY_SPEND_LOCK_KEY = 'matrix:free-tier:daily-funded-spend';

export interface FreeFundingConfig {
  /** Global ceiling on free runtimes' funded spend per UTC day; unset refuses all free funded work. */
  dailyFundedSpendMicrousd?: number;
}

type Executor = PlatformDB['executor'];
type Identity = { ownerId: string; machineId: string; runtimeSlot: string };
export type FreeAllowanceGrant = (trx: PlatformDB, input: {
  entryId: string; identity: Identity; kind: 'promotional_grant'; amountMicrousd: number;
  sourceReference: string; expiresAt: string;
}, createdAt: string) => Promise<unknown>;

function monthBounds(at: Date): { label: string; next: string } {
  const next = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { label: at.toISOString().slice(0, 7), next: next.toISOString() };
}

/** One allowance per owner per month, whichever of the owner's runtimes asks first. */
export function freeAllowanceEntryId(ownerId: string, at: Date): string {
  return `${ALLOWANCE_ENTRY_PREFIX}${createHash('sha256').update(ownerId).digest('hex')}:${monthBounds(at).label}`;
}

/**
 * The monthly allowance is owner-wide, like a promotion campaign grant:
 * replaying it on another of the owner's runtimes hands off its unallocated
 * remainder instead of minting more credit.
 */
export function isFreeAllowanceEntryId(entryId: string): boolean {
  return entryId.startsWith(ALLOWANCE_ENTRY_PREFIX);
}

export function assertFreeModel(modelId: string): void {
  if (modelId !== FREE_MANAGED_MODEL_ID) throw new AiFundedPolicyError('model_not_allowed');
}

/**
 * Call under the owner's exclusive account-deletion fence and funded-AI
 * advisory lock (the grant takes the exclusive fence itself, so a caller
 * holding only the shared funding fence would upgrade it and could deadlock).
 * The ledger insert is idempotent on its entry id; the existence check only
 * skips the grant's locks once the month's allowance is on this runtime. An
 * allowance left on a retired runtime (deleted and replaced the same month) is
 * replayed here, which moves its unspent remainder without a second grant.
 */
export async function grantFreeMonthlyAllowance(
  trx: PlatformDB, identity: Identity, at: Date, grant: FreeAllowanceGrant,
): Promise<void> {
  const entryId = freeAllowanceEntryId(identity.ownerId, at);
  const existing = await trx.executor.selectFrom('ai_funded_promotional_grant_balances as g')
    .innerJoin('user_machines as m', 'm.machine_id', 'g.machine_id')
    .select(['g.machine_id', 'm.deleted_at'])
    .where('g.grant_entry_id', '=', entryId).executeTakeFirst();
  if (existing && (existing.machine_id === identity.machineId || existing.deleted_at === null)) return;
  await grant(trx, {
    entryId, identity, kind: 'promotional_grant', amountMicrousd: FREE_MONTHLY_ALLOWANCE_MICROUSD,
    sourceReference: ALLOWANCE_SOURCE, expiresAt: monthBounds(at).next,
  }, at.toISOString());
}

export function utcDayStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/** The daily ceiling resets at the next UTC midnight; that is when a busy refusal clears. */
export function nextUtcDay(now: Date): { at: string; afterSeconds: number } {
  const next = new Date(Date.parse(utcDayStart(now)) + 86_400_000);
  return { at: next.toISOString(), afterSeconds: Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000)) };
}

/**
 * Today's funded spend of free runtimes, read from the funded reservation
 * ledger: settled work at its actual cost, active and expired work at the
 * authorized provider maximum while the actual cost is unknown, and released
 * work at any recorded actual cost. A reservation counts by its `free_funded` mark, recorded at
 * creation, not by the owner's current plan, so an upgrade later the same day
 * never frees spending already made. The created_at index bounds the scan to
 * today's reservations.
 */
export async function readDailyFundedSpend(executor: Executor, now: Date): Promise<number> {
  const result = await sql<{ spent: string | number }>`
    SELECT COALESCE(SUM(CASE
      WHEN r.status = 'settled' THEN COALESCE(r.actual_microusd, r.reserved_microusd)
      WHEN r.status = 'released' THEN COALESCE(r.actual_microusd, 0)
      ELSE GREATEST(r.reserved_microusd, COALESCE(r.actual_microusd, 0),
        COALESCE((r.authorization_response::jsonb #>> '{reservation,maxCostMicrousd}')::bigint, 0))
    END), 0) AS spent
    FROM ai_funded_usage_reservations r
    WHERE r.created_at >= ${utcDayStart(now)} AND r.free_funded
  `.execute(executor);
  return Number(result.rows[0]?.spent ?? 0);
}

/**
 * Takes the global daily-spend lock last, after every owner and balance lock,
 * so the order never cycles; the caller inserts the reservation in the same
 * transaction, so the lock covers the read and the write. Over the ceiling is
 * busy until the next UTC day; an unset ceiling is a configuration gap, so it
 * is unavailable, not busy.
 */
export async function admitFreeDailySpend(
  executor: Executor, config: FreeFundingConfig, maxCostMicrousd: number, now: Date,
): Promise<void> {
  const ceiling = config.dailyFundedSpendMicrousd;
  if (ceiling === undefined) throw new AiFundedPolicyError('unavailable');
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${DAILY_SPEND_LOCK_KEY}, 0))`.execute(executor);
  if (await readDailyFundedSpend(executor, now) + maxCostMicrousd > ceiling) {
    throw new AiFundedPolicyError('busy', undefined, nextUtcDay(now));
  }
}
