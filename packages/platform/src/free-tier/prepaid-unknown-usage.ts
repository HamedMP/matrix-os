import { NoResultError, sql, type Selectable } from 'kysely';
import { z } from 'zod/v4';
import { releaseCustomerCharge } from '../ai-funded-customer-charge-release.js';
import { AiFundedPolicyError } from '../ai-funded-policy-errors.js';
import type { AiFundedUsageReservationsTable, PlatformDB } from '../db.js';
import { freeMetalMachine } from './free-runtime.js';

/**
 * Free prepaid requests whose final usage never arrived (spec 2691, owner
 * decision 2026-11-16, A3; ported from PR #3437 for free metal runtimes, ENG-520 P7). The hold stays reserved and blocks the owner's next
 * funded request while it is unresolved: the terminal outcome and the expiry
 * cleanup leave it alone, and an exact settlement that arrives meanwhile wins.
 * Once the reservation has expired and the grace below has passed, the sweep
 * releases it without a customer debit; the cost is Matrix-absorbed. The
 * released hold still counts at its hold in the free daily ceiling
 * (`readDailyFundedSpend` counts expired holds at their hold), and the month
 * budget is not charged.
 *
 * Deliberately unguarded: the operator execution-recovery routes, an attested
 * support escape hatch that lifts only the owner barrier, never the hold, so the
 * sweep still releases it.
 */

type Executor = PlatformDB['executor'];

/**
 * After a free prepaid request's reservation expires, how long its unknown hold
 * stays blocking before the sweep releases it. It matches the JEV manual review
 * grace, so a relay's late settlement retries land first.
 */
export const FREE_PREPAID_UNKNOWN_USAGE_GRACE_MS = 10 * 60_000;

/**
 * True for a reservation row that is a free runtime's prepaid usage hold: usage
 * billing with no postpaid policy, on a free metal runtime.
 */
export function freePrepaidHold() {
  return sql<boolean>`(ai_funded_usage_reservations.authorization_response::jsonb #>> '{reservation,billingMode}' = 'usage'
    AND ai_funded_usage_reservations.authorization_response::jsonb #> '{reservation,billingPolicy}' IS NULL
    AND ${freeMetalMachine('ai_funded_usage_reservations.machine_id')})`;
}

export async function isFreePrepaidHold(
  executor: Executor,
  row: Pick<Selectable<AiFundedUsageReservationsTable>, 'reservation_id'>,
): Promise<boolean> {
  const match = await executor.selectFrom('ai_funded_usage_reservations').select('reservation_id')
    .where('reservation_id', '=', row.reservation_id).where(freePrepaidHold()).executeTakeFirst();
  return match !== undefined;
}

function unresolved(executor: Executor, dueBefore: string) {
  return executor.selectFrom('ai_funded_usage_reservations')
    .where('status', '=', 'in_flight').where('actual_microusd', 'is', null)
    .where('customer_charge_release', 'is', null).where('charge_waiver', 'is', null)
    .where('expires_at', '<=', dueBefore).where(freePrepaidHold());
}

function isDataError(error: unknown): boolean {
  return error instanceof AiFundedPolicyError || error instanceof NoResultError || error instanceof z.ZodError
    || (error instanceof Error && /^Funded AI .* invariant violated$/.test(error.message));
}

/**
 * Releases a bounded batch of due unknown free holds. Each release runs under
 * the funded owner lock and the request's row lock, re-checks the row there,
 * and moves it out of `in_flight` with a status-guarded update, so concurrent
 * instances and a racing exact settlement resolve each request once.
 */
export async function releaseUnknownFreeHolds(options: { db: PlatformDB; now: () => Date }, limit: number): Promise<number> {
  const due = () => new Date(options.now().getTime() - FREE_PREPAID_UNKNOWN_USAGE_GRACE_MS).toISOString();
  const candidates = await unresolved(options.db.executor, due()).select(['reservation_id', 'owner_id', 'machine_id'])
    .orderBy('expires_at').orderBy('reservation_id').limit(limit).execute();
  let released = 0;
  for (const candidate of candidates) {
    try {
      released += await options.db.transaction(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${candidate.owner_id}`}, 0))`.execute(trx.executor);
        await trx.executor.selectFrom('user_machines').select('machine_id')
          .where('machine_id', '=', candidate.machine_id).forNoKeyUpdate().executeTakeFirstOrThrow();
        const row = await unresolved(trx.executor, due()).selectAll()
          .where('reservation_id', '=', candidate.reservation_id).forUpdate().executeTakeFirst();
        // Settled exactly, or released by another instance, since the candidate read.
        if (!row) return 0;
        const checkedAt = options.now().toISOString();
        await releaseCustomerCharge(trx.executor, row, 'usage_unknown', checkedAt, options.now);
        return 1;
      });
    } catch (error) {
      if (!isDataError(error)) throw error;
      console.warn('[funded-ai] Unknown free hold left for the next sweep', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
  return released;
}
