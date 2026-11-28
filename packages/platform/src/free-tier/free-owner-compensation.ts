import { sql, type ColumnType, type Expression, type RawBuilder } from 'kysely';
import type { PlatformDB } from '../db.js';
import type { FreeOwnerCheckoutRefundStatus, StripeBillingClient } from '../billing/stripe-client.js';
import { buildFreeEntitlement, FREE_RUNTIME_SLOT } from './free-entitlement.js';
import type { BillingEntitlement } from '../billing.js';

/**
 * ENG-520 launch guard, layer 3: compensation for a paid Checkout that a free
 * owner completed anyway. Strictly attempt-scoped: a row exists only for a
 * session we recorded as this owner's checkout attempt, which either completed
 * while the owner was free or was found complete by the guard's sweep. Only
 * that session's own payment (its first invoice) is refunded; other invoices
 * on the subscription, and any subscription without such an attempt, are
 * never touched.
 *
 * Lifecycle: pending -> (cancel, void or refund) -> refund_pending ->
 * done once Stripe reports the refund succeeded (webhook or poll), or once
 * the payment is void, uncollectible or nothing was charged. A failed refund
 * is alerted and retried a bounded number of rounds, then left as
 * refund_failed for an operator. Stripe is only called by the sweep, outside
 * database transactions; rows are leased, and `generation` counts re-arms so
 * a sweep never overwrites a newer event.
 */

export type FreeOwnerCompensationStatus = 'pending' | 'awaiting_settlement' | 'refund_pending' | 'refund_failed' | 'done';

export interface FreeOwnerCompensationsTable {
  stripe_checkout_session_id: string;
  checkout_attempt_id: string;
  stripe_subscription_id: string | null;
  status: FreeOwnerCompensationStatus;
  refund_id: string | null;
  refund_status: FreeOwnerCheckoutRefundStatus | null;
  refund_round: ColumnType<number, number | undefined, number>;
  generation: ColumnType<number, number | undefined, number>;
  attempts: ColumnType<number, number | undefined, number>;
  lease_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
  completed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export const FREE_OWNER_CHARGE_COMPENSATION_EVENT = 'matrix_billing_free_owner_charge_compensation';

const SWEEP_BATCH = 25;
const LEASE_MS = 5 * 60_000;
const RECHECK_MS = 30 * 60_000;
const MAX_RETRY_DELAY_MS = 60 * 60_000;
/** Automatic refund rounds after a failed refund; later rounds need an operator. */
export const MAX_REFUND_ROUNDS = 3;
const SESSION_ID = /^cs_[A-Za-z0-9_]{1,255}$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{1,255}$/;
const REFUND_ID = /^re_[A-Za-z0-9]{1,255}$/;

type Capture = (event: string, options?: { properties?: Record<string, string | number | boolean | undefined> }) => void;

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function alertRefundFailed(capture: Capture | undefined, source: string): void {
  console.error('[billing] ALERT free owner refund failed; compensation needs a retry or operator review');
  try {
    capture?.(FREE_OWNER_CHARGE_COMPENSATION_EVENT, { properties: { compensation: 'refund_failed', source } });
  } catch (error: unknown) {
    console.warn('[billing] compensation telemetry failed:', errorKind(error));
  }
}

/** When the owner joined the free plan, or null when they are not on it. */
export async function freeOwnerSince(db: PlatformDB, clerkUserId: string): Promise<Date | null> {
  const entitlement = await db.executor.selectFrom('billing_entitlements').select(['source', 'effective_from'])
    .where('clerk_user_id', '=', clerkUserId).executeTakeFirst();
  if (entitlement?.source === 'free') return new Date(entitlement.effective_from);
  const machine = await db.executor.selectFrom('user_machines').select('provisioned_at')
    .where('clerk_user_id', '=', clerkUserId).where('deleted_at', 'is', null)
    .where('substrate', '=', 'metal').where('runtime_slot', '=', FREE_RUNTIME_SLOT)
    .orderBy('provisioned_at').executeTakeFirst();
  return machine ? new Date(machine.provisioned_at) : null;
}

/**
 * Queues (or re-arms) compensation for one blocked checkout session, inside
 * the caller's transaction. True when newly queued.
 */
export async function enqueueCheckoutCompensation(db: PlatformDB, input: {
  stripeSessionId: string; checkoutAttemptId: string; stripeSubscriptionId: string | null; at: string;
}): Promise<boolean> {
  if (!SESSION_ID.test(input.stripeSessionId)) return false;
  const subscription = input.stripeSubscriptionId && SUBSCRIPTION_ID.test(input.stripeSubscriptionId)
    ? input.stripeSubscriptionId : null;
  const row = await db.executor.insertInto('billing_free_owner_compensations')
    .values({
      stripe_checkout_session_id: input.stripeSessionId, checkout_attempt_id: input.checkoutAttemptId,
      stripe_subscription_id: subscription, status: 'pending', refund_id: null, refund_status: null,
      created_at: input.at, updated_at: input.at,
    })
    .onConflict((oc) => oc.column('stripe_checkout_session_id').doUpdateSet({
      status: sql<FreeOwnerCompensationStatus>`CASE WHEN billing_free_owner_compensations.status = 'refund_failed'
        THEN billing_free_owner_compensations.status ELSE 'pending' END`,
      lease_until: null,
      generation: sql<number>`billing_free_owner_compensations.generation + 1`,
      stripe_subscription_id: sql<string | null>`COALESCE(billing_free_owner_compensations.stripe_subscription_id, excluded.stripe_subscription_id)`,
      updated_at: input.at,
    }))
    .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
    .executeTakeFirst();
  return row?.inserted === true;
}

export async function compensationForSession(db: PlatformDB, stripeSessionId: string) {
  return db.executor.selectFrom('billing_free_owner_compensations').select(['stripe_checkout_session_id', 'status'])
    .where('stripe_checkout_session_id', '=', stripeSessionId).executeTakeFirst();
}

export async function compensationHoldsSubscription(db: PlatformDB, stripeSubscriptionId: string): Promise<boolean> {
  const row = await db.executor.selectFrom('billing_free_owner_compensations').select('stripe_checkout_session_id')
    .where('stripe_subscription_id', '=', stripeSubscriptionId).executeTakeFirst();
  return Boolean(row);
}

/** Re-arms the compensations of a subscription (a late payment on it). True when one exists. */
export async function rearmCompensationsForSubscription(db: PlatformDB, stripeSubscriptionId: string, at: string): Promise<boolean> {
  const rows = await db.executor.updateTable('billing_free_owner_compensations')
    .set({
      status: sql<FreeOwnerCompensationStatus>`CASE WHEN status = 'refund_failed' THEN status ELSE 'pending' END`,
      lease_until: null, updated_at: at, generation: sql<number>`generation + 1`,
    })
    .where('stripe_subscription_id', '=', stripeSubscriptionId)
    .returning('stripe_checkout_session_id')
    .execute();
  return rows.length > 0;
}

/** The subscription id on a Stripe invoice object (current or legacy shape). */
export function readInvoiceSubscriptionId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const invoice = value as { subscription?: unknown; parent?: { subscription_details?: { subscription?: unknown } } };
  const ref = invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
  const id = typeof ref === 'string' ? ref : ref && typeof ref === 'object' ? (ref as { id?: unknown }).id : null;
  return typeof id === 'string' && SUBSCRIPTION_ID.test(id) ? id : null;
}

function statusForRefund(refundStatus: FreeOwnerCheckoutRefundStatus): FreeOwnerCompensationStatus {
  if (refundStatus === 'succeeded') return 'done';
  if (refundStatus === 'failed' || refundStatus === 'canceled') return 'refund_failed';
  return 'refund_pending';
}

/**
 * Applies a refund webhook (refund.updated, refund.failed, charge.refund.updated)
 * to the compensation that created the refund. False when the refund is not ours.
 */
export async function applyCompensationRefundEvent(db: PlatformDB, value: unknown, at: string, capture?: Capture): Promise<boolean> {
  if (!value || typeof value !== 'object') return false;
  const refund = value as { id?: unknown; status?: unknown };
  if (typeof refund.id !== 'string' || !REFUND_ID.test(refund.id)) return false;
  const known = ['pending', 'requires_action', 'succeeded', 'failed', 'canceled'] as const;
  const refundStatus = known.find((status) => status === refund.status);
  if (!refundStatus) return false;
  const status = statusForRefund(refundStatus);
  const row = await db.executor.updateTable('billing_free_owner_compensations')
    .set({
      refund_status: refundStatus, status, updated_at: at, generation: sql<number>`generation + 1`,
      lease_until: status === 'refund_failed' ? null : sql<Date | null>`lease_until`,
      completed_at: status === 'done' ? at : null,
    })
    .where('refund_id', '=', refund.id)
    .where('status', '!=', 'done')
    .returning('stripe_checkout_session_id')
    .executeTakeFirst();
  if (!row) {
    const known = await db.executor.selectFrom('billing_free_owner_compensations').select('stripe_checkout_session_id')
      .where('refund_id', '=', refund.id).executeTakeFirst();
    return Boolean(known);
  }
  if (status === 'refund_failed') alertRefundFailed(capture, 'webhook');
  return true;
}

/**
 * True when a subscription belongs to a blocked free checkout: one already
 * tied to a compensation, or, for an owner on the free plan, an unrecorded
 * subscription created while free in a slot where this owner has a checkout
 * attempt started while free. A former paid owner's historical subscription
 * (recorded here, or created before free admission) is never held.
 */
export async function blockedCheckoutHoldsSubscription(db: PlatformDB, input: {
  clerkUserId: string; runtimeSlot: string; stripeSubscriptionId: string; subscriptionCreated: unknown;
}): Promise<boolean> {
  // A stored subscription (recorded before the guard shipped) always flows through
  // the normal handlers, so its cancellation clears the stored paid rights.
  const recorded = await db.executor.selectFrom('billing_subscriptions').select('stripe_subscription_id')
    .where('stripe_subscription_id', '=', input.stripeSubscriptionId).executeTakeFirst();
  if (recorded) return false;
  if (await compensationHoldsSubscription(db, input.stripeSubscriptionId)) return true;
  const since = await freeOwnerSince(db, input.clerkUserId);
  if (!since || typeof input.subscriptionCreated !== 'number' || input.subscriptionCreated * 1000 < since.getTime()) return false;
  const attempts = await db.executor.selectFrom('billing_checkout_attempts').select('created_at')
    .where('clerk_user_id', '=', input.clerkUserId)
    .where('runtime_slot', '=', input.runtimeSlot)
    .where('status', 'in', ['creating', 'open', 'paid', 'abandoned'])
    .execute();
  return attempts.some((attempt) => Date.parse(attempt.created_at) >= since.getTime());
}

/** SQL for freeOwnerSince over an owner id expression (null when not free). */
export function freeOwnerSinceSql(owner: Expression<unknown>): RawBuilder<Date | null> {
  return sql<Date | null>`COALESCE(
    (SELECT since_entitlement.effective_from::timestamptz FROM billing_entitlements since_entitlement
      WHERE since_entitlement.clerk_user_id = ${owner} AND since_entitlement.source = 'free'),
    (SELECT MIN(since_machine.provisioned_at::timestamptz) FROM user_machines since_machine
      WHERE since_machine.clerk_user_id = ${owner} AND since_machine.deleted_at IS NULL
        AND since_machine.substrate = 'metal' AND since_machine.runtime_slot = ${FREE_RUNTIME_SLOT}))`;
}

/**
 * After a compensated subscription that was stored before the guard shipped
 * is canceled, its paid rights are void (the payment was refunded), even if
 * the projection still carries a period end. Restore the owner's free
 * entitlement (the caller persists it in the webhook transaction), unless another subscription or
 * override still grants paid rights. Their free metal runtime is never touched.
 */
export async function freeEntitlementToRestoreAfterCompensation(db: PlatformDB, input: {
  clerkUserId: string; stripeSubscriptionId: string; at: Date;
}): Promise<BillingEntitlement | null> {
  if (!await compensationHoldsSubscription(db, input.stripeSubscriptionId)) return null;
  const since = await freeOwnerSince(db, input.clerkUserId);
  if (!since) return null;
  const subscriptions = await db.executor.selectFrom('billing_subscriptions')
    .select(['stripe_subscription_id', 'status']).where('clerk_user_id', '=', input.clerkUserId).execute();
  const ended = (status: string) => status === 'canceled' || status === 'ended';
  const compensated = subscriptions.find((row) => row.stripe_subscription_id === input.stripeSubscriptionId);
  if (!compensated || !ended(compensated.status)) return null;
  if (subscriptions.some((row) => row.stripe_subscription_id !== input.stripeSubscriptionId && !ended(row.status))) return null;
  const atIso = input.at.toISOString();
  const override = await db.executor.selectFrom('billing_entitlement_overrides').select('id')
    .where('clerk_user_id', '=', input.clerkUserId).where('revoked_at', 'is', null).where('status', '=', 'active')
    .where(sql<boolean>`(expires_at IS NULL OR expires_at::timestamptz > ${atIso}::timestamptz)`)
    .executeTakeFirst();
  if (override) return null;
  return { ...buildFreeEntitlement(input.clerkUserId, input.at), effectiveFrom: since.toISOString() };
}

async function claim(db: PlatformDB, at: Date) {
  return db.transaction(async (trx) => {
    const due = await trx.executor.selectFrom('billing_free_owner_compensations').select('stripe_checkout_session_id')
      .where((eb) => eb.or([
        eb('status', 'in', ['pending', 'awaiting_settlement', 'refund_pending']),
        eb.and([eb('status', '=', 'refund_failed'), eb('refund_round', '<', MAX_REFUND_ROUNDS)]),
      ]))
      .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<=', at)]))
      .orderBy('created_at').limit(SWEEP_BATCH)
      .forUpdate().skipLocked()
      .execute();
    if (due.length === 0) return [];
    return trx.executor.updateTable('billing_free_owner_compensations')
      .set({ lease_until: new Date(at.getTime() + LEASE_MS).toISOString(), updated_at: at.toISOString() })
      .where('stripe_checkout_session_id', 'in', due.map((row) => row.stripe_checkout_session_id))
      .returning(['stripe_checkout_session_id', 'status', 'refund_id', 'refund_status', 'refund_round', 'attempts', 'generation'])
      .execute();
  });
}

/** One bounded compensation pass over queued blocked checkouts. */
export async function runCheckoutCompensations(deps: {
  db: PlatformDB;
  stripe: Pick<StripeBillingClient, 'compensateFreeOwnerCheckout'>;
  now?: () => Date;
  captureEvent?: Capture;
}): Promise<void> {
  const compensateCheckout = deps.stripe.compensateFreeOwnerCheckout?.bind(deps.stripe);
  if (!compensateCheckout) return;
  const at = (deps.now ?? (() => new Date()))();
  const atIso = at.toISOString();
  for (const row of await claim(deps.db, at)) {
    const attempts = row.attempts + 1;
    // A retry after a failed refund starts a new refund round (a new idempotency key).
    const retryingFailedRefund = row.status === 'refund_failed';
    const refundRound = retryingFailedRefund ? row.refund_round + 1 : row.refund_round;
    const pollRefundId = !retryingFailedRefund && row.refund_id ? row.refund_id : null;
    const update = (values: Partial<{
      status: FreeOwnerCompensationStatus; refund_id: string | null; refund_status: FreeOwnerCheckoutRefundStatus | null;
      stripe_subscription_id: string | null; lease_until: string | null; completed_at: string | null; refund_round: number;
    }>) => deps.db.executor.updateTable('billing_free_owner_compensations')
      .set({ ...values, attempts, updated_at: atIso })
      .where('stripe_checkout_session_id', '=', row.stripe_checkout_session_id)
      .where('generation', '=', row.generation)
      .execute();
    try {
      const result = await compensateCheckout({
        sessionId: row.stripe_checkout_session_id, refundId: pollRefundId, refundRound,
      });
      const subscription = result.subscriptionId && SUBSCRIPTION_ID.test(result.subscriptionId) ? result.subscriptionId : null;
      if (result.refund) {
        const status = statusForRefund(result.refund.status);
        await update({
          status, refund_id: result.refund.id, refund_status: result.refund.status, refund_round: refundRound,
          stripe_subscription_id: subscription,
          lease_until: status === 'refund_pending' ? new Date(at.getTime() + RECHECK_MS).toISOString() : null,
          completed_at: status === 'done' ? atIso : null,
        });
        if (status === 'refund_failed') alertRefundFailed(deps.captureEvent, 'poll');
      } else if (result.settled) {
        await update({ status: 'done', stripe_subscription_id: subscription, lease_until: null, completed_at: atIso, refund_round: refundRound });
      } else {
        // The session's invoice could still be paid: recheck later.
        await update({
          status: 'awaiting_settlement', stripe_subscription_id: subscription,
          lease_until: new Date(at.getTime() + RECHECK_MS).toISOString(),
        });
      }
    } catch (error: unknown) {
      console.error('[billing] ALERT free owner charge compensation failed; retrying:', errorKind(error));
      await update({ lease_until: new Date(at.getTime() + Math.min(2 ** attempts * 60_000, MAX_RETRY_DELAY_MS)).toISOString() });
    }
  }
}
