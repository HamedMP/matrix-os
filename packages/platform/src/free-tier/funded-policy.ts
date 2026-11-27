import { FREE_MANAGED_MODEL_ID } from '@matrix-os/contracts';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { PlatformDB } from '../db.js';
import { AiFundedPolicyError } from '../ai-funded-policy-errors.js';

/**
 * Funded AI for free metal runtimes (spec 2691 D2, ENG-520 Task P7; ported
 * from PR #3437): the once-per-owner starter credit plus a $5 allowance each
 * UTC day, capped at $20 of allowance usage per owner per UTC calendar month,
 * on the managed default model only, under a global daily spend ceiling. Each
 * day's allowance is an ordinary promotional grant that expires when its day
 * ends, so admission, holds and settlement stay on the one funded reservation
 * path and ledger. Own-account sources never come through here.
 */

export { FREE_MANAGED_MODEL_ID };
export const FREE_DAILY_ALLOWANCE_MICROUSD = 5_000_000;
export const FREE_MONTHLY_ALLOWANCE_CAP_MICROUSD = 20_000_000;
const ALLOWANCE_SOURCE = 'matrix-free-daily-allowance';
const ALLOWANCE_ENTRY_PREFIX = 'free-daily:';
// The monthly allowance this daily allowance replaces. A grant already made this month still counts
// toward the cap and still moves with its owner until it expires at the month's end.
const LEGACY_MONTHLY_ENTRY_PREFIX = 'free-monthly:';
const ACTIVE_HOLD_STATUSES = ['reserved', 'starting', 'in_flight', 'settling'] as const;
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

const ownerHash = (ownerId: string) => createHash('sha256').update(ownerId).digest('hex');
const dayLabel = (at: Date) => at.toISOString().slice(0, 10);

/** One allowance per owner per UTC day, whichever of the owner's runtimes asks first. */
export function freeAllowanceEntryId(ownerId: string, at: Date): string {
  return `${ALLOWANCE_ENTRY_PREFIX}${ownerHash(ownerId)}:${dayLabel(at)}`;
}

/**
 * The daily allowance is owner-wide, like a promotion campaign grant:
 * replaying it on another of the owner's runtimes hands off its unallocated
 * remainder instead of minting more credit.
 */
export function isFreeAllowanceEntryId(entryId: string): boolean {
  return entryId.startsWith(ALLOWANCE_ENTRY_PREFIX) || entryId.startsWith(LEGACY_MONTHLY_ENTRY_PREFIX);
}

export function assertFreeModel(modelId: string): void {
  if (modelId !== FREE_MANAGED_MODEL_ID) throw new AiFundedPolicyError('model_not_allowed');
}

/** This month's allowance grants made before `at`'s day: the earlier days, plus any legacy monthly grant. */
function earlierAllowanceEntryIds(ownerId: string, at: Date): string[] {
  const hash = ownerHash(ownerId);
  const ids = [`${LEGACY_MONTHLY_ENTRY_PREFIX}${hash}:${at.toISOString().slice(0, 7)}`];
  for (let day = 1; day < at.getUTCDate(); day += 1) {
    ids.push(`${ALLOWANCE_ENTRY_PREFIX}${hash}:${dayLabel(new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), day)))}`);
  }
  return ids;
}

/**
 * An upper bound on the owner's allowance usage this month before `at`'s day, read from the
 * ledger in one statement (one snapshot). Per grant: its amount, less what expiry retired, less,
 * once it has expired, the remainder no active hold protects (that part can only be retired).
 * Settled spend and active holds therefore both count. A later settlement only turns part of a
 * counted hold into spend, and a released hold's credit can only be retired, so the bound never
 * grows after it is read and the monthly cap holds under concurrent settlement. A grant still
 * live (a legacy monthly grant) counts in full. A grant's expiry entries are written against the
 * runtime holding its balance, at or after its expiry, which is after the month began.
 */
export async function readMonthAllowanceUsage(executor: Executor, ownerId: string, at: Date): Promise<number> {
  const monthStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
  const atIso = at.toISOString();
  const result = await sql<{ used: string | number }>`
    SELECT COALESCE(SUM(
      l.amount_microusd
      - COALESCE((
        SELECT SUM(-e.amount_microusd) FROM ai_funded_credit_ledger e
        WHERE e.machine_id = b.machine_id AND e.created_at >= ${monthStart}
          AND e.kind = 'promotional_expiry' AND e.source_reference = l.entry_id
      ), 0)
      - CASE WHEN l.expires_at <= ${atIso} THEN GREATEST(0, COALESCE(b.remaining_microusd, 0) - COALESCE((
        SELECT SUM(a.amount_microusd)
        FROM ai_funded_reservation_promotional_allocations a
        JOIN ai_funded_usage_reservations r ON r.reservation_id = a.reservation_id
        WHERE a.grant_entry_id = l.entry_id AND r.status IN (${sql.join([...ACTIVE_HOLD_STATUSES])})
      ), 0)) ELSE 0 END
    ), 0) AS used
    FROM ai_funded_credit_ledger l
    LEFT JOIN ai_funded_promotional_grant_balances b ON b.grant_entry_id = l.entry_id
    WHERE l.entry_id IN (${sql.join(earlierAllowanceEntryIds(ownerId, at))})
      AND l.owner_id = ${ownerId} AND l.kind = 'promotional_grant'
  `.execute(executor);
  const used = Number(result.rows[0]?.used ?? 0);
  if (!Number.isSafeInteger(used) || used < 0) throw new Error('Free allowance usage invariant violated');
  return used;
}

/**
 * Call under the owner's exclusive account-deletion fence and funded-AI
 * advisory lock (the grant takes the exclusive fence itself, so a caller
 * holding only the shared funding fence would upgrade it and could deadlock).
 * The owner lock serializes the usage read with every grant and admission for
 * the owner, and the ledger insert is idempotent on the day's entry id, so two
 * first requests of a day make one grant. The day's grant is $5, or what is
 * left of the month's $20 cap; none once the cap is reached. An allowance left
 * on a retired runtime (deleted and replaced the same day) is replayed at its
 * recorded amount, which moves its unspent remainder without a second grant.
 */
export async function grantFreeDailyAllowance(
  trx: PlatformDB, identity: Identity, at: Date, grant: FreeAllowanceGrant,
): Promise<void> {
  const entryId = freeAllowanceEntryId(identity.ownerId, at);
  const expiresAt = nextUtcDay(at).at;
  const existing = await trx.executor.selectFrom('ai_funded_credit_ledger as l')
    .leftJoin('ai_funded_promotional_grant_balances as g', 'g.grant_entry_id', 'l.entry_id')
    .leftJoin('user_machines as m', 'm.machine_id', 'g.machine_id')
    .select(['l.amount_microusd', 'g.machine_id', 'm.deleted_at'])
    .where('l.entry_id', '=', entryId).executeTakeFirst();
  if (existing && (existing.machine_id === identity.machineId || (existing.machine_id !== null && existing.deleted_at === null))) return;
  const amountMicrousd = existing
    ? Number(existing.amount_microusd)
    : Math.min(FREE_DAILY_ALLOWANCE_MICROUSD,
      FREE_MONTHLY_ALLOWANCE_CAP_MICROUSD - await readMonthAllowanceUsage(trx.executor, identity.ownerId, at));
  if (amountMicrousd <= 0) return;
  await grant(trx, {
    entryId, identity, kind: 'promotional_grant', amountMicrousd,
    sourceReference: ALLOWANCE_SOURCE, expiresAt,
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
  executor: Executor, config: FreeFundingConfig, maxCostMicrousd: number, now: () => Date,
): Promise<Date> {
  const ceiling = config.dailyFundedSpendMicrousd;
  if (ceiling === undefined) throw new AiFundedPolicyError('unavailable');
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${DAILY_SPEND_LOCK_KEY}, 0))`.execute(executor);
  // Sample under the spend lock and use this same timestamp for the reservation row.
  const admittedAt = now();
  if (await readDailyFundedSpend(executor, admittedAt) + maxCostMicrousd > ceiling) {
    throw new AiFundedPolicyError('busy', undefined, nextUtcDay(admittedAt));
  }
  return admittedAt;
}
