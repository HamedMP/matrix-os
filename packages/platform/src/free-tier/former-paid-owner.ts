import { sql, type ExpressionBuilder } from 'kysely';
import { toBillingEntitlementRow } from '../database/billing-records.js';
import type { BillingEntitlement } from '../billing.js';
import type { PlatformDatabase, PlatformDB } from '../db.js';

/**
 * A former paid owner may take the free plan once every paid right has ended.
 * Ended means a canceled or ended Stripe status (incomplete_expired projects to
 * ended) with no grace period and no effective end still ahead. Active,
 * trialing, past-due, unpaid, incomplete and grace-period owners stay paid.
 */
const ENDED_STATUSES = ['canceled', 'ended'] as const;

export class FreeEntitlementReplacementRefused extends Error {
  constructor() {
    super('stored entitlement is no longer replaceable by the free plan');
    this.name = 'FreeEntitlementReplacementRefused';
  }
}

function notAhead(column: string, at: string) {
  return sql<boolean>`(${sql.ref(column)} IS NULL OR ${sql.ref(column)}::timestamptz <= ${at}::timestamptz)`;
}

function endedEntitlement(at: string) {
  return (eb: ExpressionBuilder<PlatformDatabase, 'billing_entitlements'>) => eb.and([
    eb('billing_entitlements.source', '!=', 'free'),
    eb('billing_entitlements.status', 'in', ENDED_STATUSES),
    notAhead('billing_entitlements.grace_period_ends_at', at),
    notAhead('billing_entitlements.effective_until', at),
  ]);
}

/** True when no subscription, override, or VPS still grants or holds paid rights. */
export async function paidRightsEnded(db: PlatformDB, clerkUserId: string, at: string): Promise<boolean> {
  const subscription = await db.executor.selectFrom('billing_subscriptions').select('stripe_subscription_id')
    .where('clerk_user_id', '=', clerkUserId)
    .where((eb) => eb.or([
      eb('status', 'not in', ENDED_STATUSES),
      eb.not(notAhead('grace_period_ends_at', at)),
    ]))
    .executeTakeFirst();
  if (subscription) return false;
  const override = await db.executor.selectFrom('billing_entitlement_overrides').select('id')
    .where('clerk_user_id', '=', clerkUserId)
    .where('revoked_at', 'is', null)
    .where('status', '=', 'active')
    .where(sql<boolean>`(expires_at IS NULL OR expires_at::timestamptz > ${at}::timestamptz)`)
    .executeTakeFirst();
  return !override;
}

export async function storedEntitlementEnded(db: PlatformDB, clerkUserId: string, at: string): Promise<boolean> {
  const row = await db.executor.selectFrom('billing_entitlements').select('clerk_user_id')
    .where('clerk_user_id', '=', clerkUserId)
    .where(endedEntitlement(at))
    .executeTakeFirst();
  return Boolean(row);
}

export async function hasLiveVps(db: PlatformDB, clerkUserId: string): Promise<boolean> {
  const row = await db.executor.selectFrom('user_machines').select('machine_id')
    .where('clerk_user_id', '=', clerkUserId)
    .where('substrate', '!=', 'container')
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return Boolean(row);
}

/**
 * Writes the free entitlement in one statement: insert, or replace a stored
 * free or ended paid row. The replacement keeps the replaced row's
 * `updated_at`, so any later Stripe projection (which only lands when its
 * `updated_at` is not older) still wins even if its clock read earlier. A row
 * that stopped being replaceable makes the statement write nothing, and the
 * caller rolls back.
 */
export async function writeFreeEntitlement(db: PlatformDB, entitlement: BillingEntitlement): Promise<void> {
  const row = toBillingEntitlementRow(entitlement);
  const at = entitlement.updatedAt;
  const { updated_at: _updatedAt, clerk_user_id: _owner, ...replacement } = row;
  const written = await db.executor.insertInto('billing_entitlements').values(row)
    .onConflict((oc) => oc.column('clerk_user_id')
      .doUpdateSet(replacement)
      .where((eb) => eb.or([eb('billing_entitlements.source', '=', 'free'), endedEntitlement(at)(eb)])))
    .returning('clerk_user_id')
    .executeTakeFirst();
  if (!written) throw new FreeEntitlementReplacementRefused();
}
