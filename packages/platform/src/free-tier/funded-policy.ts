import { createHash } from 'node:crypto';
import type { PlatformDB } from '../db.js';
import { AiFundedPolicyError } from '../ai-funded-policy-errors.js';
import { admitDailyFundedSpend, utcDayStart } from './capacity.js';

/**
 * Funded AI for free runtimes (spec 2691 D2): the once-per-owner starter
 * credit plus a $5 allowance each UTC calendar month, on the managed default
 * model only. The allowance is an ordinary promotional grant that expires when
 * its month ends, so admission, holds and settlement stay on the one funded
 * reservation path and ledger. Own-account sources never come through here.
 */

export const FREE_MANAGED_MODEL_ID = '@cf/zai-org/glm-5.3-flash';
export const FREE_MONTHLY_ALLOWANCE_MICROUSD = 5_000_000;
const ALLOWANCE_SOURCE = 'matrix-free-monthly-allowance';

export interface FreeFundingConfig {
  /** Global ceiling on free runtimes' funded spend per UTC day; unset refuses all free funded work. */
  dailyFundedSpendMicrousd?: number;
}

type Identity = { ownerId: string; machineId: string; runtimeSlot: string };
type GrantInTransaction = (trx: PlatformDB, input: {
  entryId: string; identity: Identity; kind: 'promotional_grant'; amountMicrousd: number;
  sourceReference: string; expiresAt: string;
}, createdAt: string) => Promise<unknown>;

function monthBounds(at: Date): { label: string; next: string } {
  const next = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { label: at.toISOString().slice(0, 7), next: next.toISOString() };
}

/** One allowance per owner per month, whichever of the owner's runtimes asks first. */
export function freeAllowanceEntryId(ownerId: string, at: Date): string {
  return `free-monthly:${createHash('sha256').update(ownerId).digest('hex')}:${monthBounds(at).label}`;
}

export function assertFreeModel(modelId: string): void {
  if (modelId !== FREE_MANAGED_MODEL_ID) throw new AiFundedPolicyError('model_not_allowed');
}

/** Call under the owner's funded-AI advisory lock, so the existence check cannot race. */
export async function grantFreeMonthlyAllowance(
  trx: PlatformDB, identity: Identity, at: Date, grant: GrantInTransaction,
): Promise<void> {
  const entryId = freeAllowanceEntryId(identity.ownerId, at);
  const existing = await trx.executor.selectFrom('ai_funded_credit_ledger').select('entry_id')
    .where('entry_id', '=', entryId).executeTakeFirst();
  if (existing) return;
  await grant(trx, {
    entryId, identity, kind: 'promotional_grant', amountMicrousd: FREE_MONTHLY_ALLOWANCE_MICROUSD,
    sourceReference: ALLOWANCE_SOURCE, expiresAt: monthBounds(at).next,
  }, at.toISOString());
}

/** The daily ceiling resets at the next UTC midnight; that is when a busy refusal clears. */
export function nextUtcDay(now: Date): { at: string; afterSeconds: number } {
  const next = new Date(Date.parse(utcDayStart(now)) + 86_400_000);
  return { at: next.toISOString(), afterSeconds: Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000)) };
}

/**
 * Takes the global daily-spend lock last, after every owner and balance lock,
 * so the order never cycles. Over the ceiling is busy until the next UTC day;
 * an unset ceiling is a configuration gap, so it is unavailable, not busy.
 */
export async function admitFreeDailySpend(
  executor: PlatformDB['executor'], config: FreeFundingConfig, holdMicrousd: number, now: Date,
): Promise<void> {
  const ceiling = config.dailyFundedSpendMicrousd;
  if (ceiling === undefined) throw new AiFundedPolicyError('unavailable');
  if (!await admitDailyFundedSpend(executor, { holdMicrousd, ceilingMicrousd: ceiling, now })) {
    throw new AiFundedPolicyError('busy', undefined, nextUtcDay(now));
  }
}
