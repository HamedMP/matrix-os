import { sql, type ColumnType } from 'kysely';
import type { PlatformDB } from '../db.js';
import type { StripeBillingClient } from '../billing/stripe-client.js';
import { createStripeBillingClient } from '../stripe-billing.js';
import { freeOwnerPredicate, ownerOnFreePlan } from './free-checkout-guard.js';
import { FREE_RUNTIME_SLOT } from './free-entitlement.js';

/**
 * ENG-520 launch guard, layers 2 and 3 (review P1). Free to paid upgrade
 * (ENG-606) does not exist, so a free owner must not pay for a plan:
 * - Layer 2 expires a free owner's open Checkout sessions in Stripe, after free
 *   admission commits and from a bounded sweep that also covers owners admitted
 *   before the guard shipped.
 * - Layer 3 cancels and refunds a subscription that still lands for a free
 *   owner. The webhook queues it here inside its transaction; Stripe is only
 *   ever called by the sweep, outside any database transaction.
 * Both are idempotent: expiry tolerates sessions already expired or complete,
 * and compensation rows are leased so concurrent sweeps never repeat a call.
 */

export interface FreeOwnerCompensationsTable {
  stripe_subscription_id: string;
  status: 'pending' | 'awaiting_settlement' | 'done';
  refund_paid_since: ColumnType<Date, Date | string, Date | string>;
  generation: ColumnType<number, number | undefined, number>;
  attempts: ColumnType<number, number | undefined, number>;
  lease_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: ColumnType<Date, Date | string, never>;
  updated_at: ColumnType<Date, Date | string, Date | string>;
  completed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export const FREE_OWNER_CHARGE_COMPENSATION_EVENT = 'matrix_billing_free_owner_charge_compensation';

const SWEEP_BATCH = 25;
const SESSIONS_PER_OWNER = 20;
const COMPENSATION_LEASE_MS = 5 * 60_000;
const MAX_RETRY_DELAY_MS = 60 * 60_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;
const SETTLEMENT_RECHECK_MS = 30 * 60_000;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]{1,255}$/;

export interface FreeOwnerBillingDeps {
  db: PlatformDB;
  stripe: Pick<StripeBillingClient, 'expireCheckoutSession' | 'cancelAndRefundSubscription'>;
  now?: () => Date;
}

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Retires the checkout attempt for one session: `expired` while it was still
 * payable, `abandoned` once it was paid (its subscription is compensated).
 * Clears the trial reservation either way, as the expiry path does.
 */
export async function retireFreeOwnerCheckoutAttempt(
  db: PlatformDB,
  stripeSessionId: string,
  status: 'expired' | 'abandoned',
  at: string,
  transactionAlreadyOpen = false,
): Promise<void> {
  const retire = async (trx: PlatformDB) => {
    const retired = await trx.executor.updateTable('billing_checkout_attempts')
      .set({ status, resolved_at: at })
      .where('stripe_session_id', '=', stripeSessionId)
      .where('status', 'in', status === 'expired' ? ['creating', 'open'] : ['creating', 'open', 'paid'])
      .returning('id')
      .execute();
    for (const row of retired) {
      await trx.executor.updateTable('billing_trial_accounts')
        .set({ trial_checkout_attempt_id: null, updated_at: at })
        .where('trial_checkout_attempt_id', '=', row.id)
        .execute();
    }
  };
  if (transactionAlreadyOpen) return retire(db);
  return db.transaction(retire);
}

/** Expires every open Checkout session of a free owner. Returns how many still need a retry. */
export async function expireOpenCheckoutsForFreeOwner(deps: FreeOwnerBillingDeps, clerkUserId: string): Promise<number> {
  const expire = deps.stripe.expireCheckoutSession?.bind(deps.stripe);
  if (!expire) return 0;
  if (!await ownerOnFreePlan(deps.db, clerkUserId)) return 0;
  const now = deps.now ?? (() => new Date());
  const attempts = await deps.db.executor.selectFrom('billing_checkout_attempts').select('stripe_session_id')
    .where('clerk_user_id', '=', clerkUserId)
    .where('status', 'in', ['creating', 'open'])
    .where('stripe_session_id', 'is not', null)
    .limit(SESSIONS_PER_OWNER)
    .execute();
  let pending = 0;
  for (const { stripe_session_id: sessionId } of attempts) {
    if (!sessionId) continue;
    let session: Awaited<ReturnType<typeof expire>>;
    try {
      session = await expire(sessionId);
    } catch (error: unknown) {
      // The attempt stays open; the next sweep retries.
      console.warn('[billing] free owner checkout expiry failed:', errorKind(error));
      pending += 1;
      continue;
    }
    if (session.clerkUserId && session.clerkUserId !== clerkUserId) {
      console.error('[billing] free owner checkout expiry skipped: session owner mismatch');
      continue;
    }
    if (session.status === 'open') {
      pending += 1;
      continue;
    }
    await retireFreeOwnerCheckoutAttempt(deps.db, sessionId, session.status === 'expired' ? 'expired' : 'abandoned',
      now().toISOString());
  }
  return pending;
}

/**
 * When the owner joined the free plan, or null when they are not on it. Only
 * a subscription created at or after this time is compensated, and only
 * payments made since then are refunded: anything earlier was real paid
 * service of a former paid owner.
 */
export async function freeOwnerSince(db: PlatformDB, clerkUserId: string): Promise<Date | null> {
  const entitlement = await db.executor.selectFrom('billing_entitlements').select(['source', 'effective_from'])
    .where('clerk_user_id', '=', clerkUserId).executeTakeFirst();
  if (entitlement?.source === 'free') return new Date(entitlement.effective_from);
  const machine = await db.executor.selectFrom('user_machines').select('provisioned_at')
    .where('clerk_user_id', '=', clerkUserId)
    .where('deleted_at', 'is', null)
    .where('substrate', '=', 'metal')
    .where('runtime_slot', '=', FREE_RUNTIME_SLOT)
    .orderBy('provisioned_at')
    .executeTakeFirst();
  return machine ? new Date(machine.provisioned_at) : null;
}

/**
 * Queues (or re-arms) a subscription for cancel and refund, inside the
 * caller's transaction. A later event for a queued subscription re-arms it
 * rather than being swallowed. True when newly queued.
 */
export async function enqueueFreeOwnerCompensation(
  db: PlatformDB, stripeSubscriptionId: string, refundPaidSince: Date, at: string,
): Promise<boolean> {
  if (!SUBSCRIPTION_ID.test(stripeSubscriptionId)) {
    console.error('[billing] ALERT free owner paid checkout with an unrecognized subscription id; needs operator review');
    return false;
  }
  const row = await db.executor.insertInto('billing_free_owner_compensations')
    .values({
      stripe_subscription_id: stripeSubscriptionId, status: 'pending', refund_paid_since: refundPaidSince.toISOString(),
      created_at: at, updated_at: at,
    })
    .onConflict((oc) => oc.column('stripe_subscription_id').doUpdateSet({
      status: 'pending',
      lease_until: null,
      generation: sql<number>`billing_free_owner_compensations.generation + 1`,
      refund_paid_since: sql<string>`LEAST(billing_free_owner_compensations.refund_paid_since, excluded.refund_paid_since)`,
      updated_at: at,
    }))
    .returning(sql<boolean>`(xmax = 0)`.as('inserted'))
    .executeTakeFirst();
  return row?.inserted === true;
}

/** Re-arms an already queued subscription (a late invoice payment). True when the subscription is queued. */
export async function rearmFreeOwnerCompensation(db: PlatformDB, stripeSubscriptionId: string, at: string): Promise<boolean> {
  const row = await db.executor.updateTable('billing_free_owner_compensations')
    .set({
      status: 'pending', lease_until: null, updated_at: at,
      generation: sql<number>`billing_free_owner_compensations.generation + 1`,
    })
    .where('stripe_subscription_id', '=', stripeSubscriptionId)
    .returning('stripe_subscription_id')
    .executeTakeFirst();
  return Boolean(row);
}

/** The subscription id on a Stripe invoice object (current or legacy shape). */
export function readInvoiceSubscriptionId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const invoice = value as { subscription?: unknown; parent?: { subscription_details?: { subscription?: unknown } } };
  const ref = invoice.parent?.subscription_details?.subscription ?? invoice.subscription;
  const id = typeof ref === 'string' ? ref : ref && typeof ref === 'object' ? (ref as { id?: unknown }).id : null;
  return typeof id === 'string' && SUBSCRIPTION_ID.test(id) ? id : null;
}

async function claimCompensations(db: PlatformDB, at: Date) {
  const leaseUntil = new Date(at.getTime() + COMPENSATION_LEASE_MS).toISOString();
  return db.transaction(async (trx) => {
    const due = await trx.executor.selectFrom('billing_free_owner_compensations').select('stripe_subscription_id')
      .where('status', 'in', ['pending', 'awaiting_settlement'])
      .where((eb) => eb.or([eb('lease_until', 'is', null), eb('lease_until', '<=', at)]))
      .orderBy('created_at')
      .limit(SWEEP_BATCH)
      .forUpdate().skipLocked()
      .execute();
    if (due.length === 0) return [];
    return trx.executor.updateTable('billing_free_owner_compensations')
      .set({ lease_until: leaseUntil, updated_at: at.toISOString() })
      .where('stripe_subscription_id', 'in', due.map((row) => row.stripe_subscription_id))
      .returning(['stripe_subscription_id', 'attempts', 'generation', 'refund_paid_since'])
      .execute();
  });
}

async function compensate(deps: FreeOwnerBillingDeps, at: Date): Promise<void> {
  const cancelAndRefund = deps.stripe.cancelAndRefundSubscription?.bind(deps.stripe);
  if (!cancelAndRefund) return;
  for (const row of await claimCompensations(deps.db, at)) {
    const attempts = row.attempts + 1;
    // Writes only land if no event re-armed the row meanwhile; a re-armed row is
    // pending with no lease, so the next sweep handles it.
    const update = (values: { status?: 'awaiting_settlement' | 'done'; lease_until: string | null; completed_at?: string }) =>
      deps.db.executor.updateTable('billing_free_owner_compensations')
        .set({ ...values, attempts, updated_at: at.toISOString() })
        .where('stripe_subscription_id', '=', row.stripe_subscription_id)
        .where('generation', '=', row.generation)
        .execute();
    try {
      const result = await cancelAndRefund(row.stripe_subscription_id, { refundPaidSince: new Date(row.refund_paid_since) });
      if (result.settled) {
        await update({ status: 'done', lease_until: null, completed_at: at.toISOString() });
      } else {
        // An invoice could still be paid: recheck later instead of finishing.
        await update({ status: 'awaiting_settlement', lease_until: new Date(at.getTime() + SETTLEMENT_RECHECK_MS).toISOString() });
      }
    } catch (error: unknown) {
      const retryAt = new Date(at.getTime() + Math.min(2 ** attempts * 60_000, MAX_RETRY_DELAY_MS));
      console.error('[billing] ALERT free owner charge compensation failed; retrying:', errorKind(error));
      await update({ lease_until: retryAt.toISOString() });
    }
  }
}

/** One bounded pass: expire free owners' open sessions, then compensate queued subscriptions. */
export async function runFreeOwnerBillingSweep(deps: FreeOwnerBillingDeps): Promise<void> {
  const at = (deps.now ?? (() => new Date()))();
  const owners = await deps.db.executor.selectFrom('billing_checkout_attempts').select('clerk_user_id').distinct()
    .where('status', 'in', ['creating', 'open'])
    .where('stripe_session_id', 'is not', null)
    .where(freeOwnerPredicate(sql.ref('billing_checkout_attempts.clerk_user_id')))
    .limit(SWEEP_BATCH)
    .execute();
  for (const { clerk_user_id: owner } of owners) {
    try {
      await expireOpenCheckoutsForFreeOwner(deps, owner);
    } catch (error: unknown) {
      console.warn('[billing] free owner checkout sweep failed for one owner:', errorKind(error));
    }
  }
  await compensate(deps, at);
}

/** Background worker: runs at start and every few minutes; the returned function stops it and waits for the pass. */
export function startFreeOwnerBillingSweep(deps: FreeOwnerBillingDeps, intervalMs = SWEEP_INTERVAL_MS): () => Promise<void> {
  let pending: Promise<void> | undefined;
  let closed = false;
  function tick() {
    if (closed || pending) return;
    pending = runFreeOwnerBillingSweep(deps).catch((error: unknown) => {
      console.warn('[billing] free owner billing sweep unavailable:', errorKind(error));
    }).finally(() => { pending = undefined; });
  }
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return async () => { closed = true; clearInterval(timer); await pending; };
}

/**
 * Startup composition: with Stripe configured, the post-admission expiry hook
 * for free signup and (when this process runs background workers) the sweep.
 */
export function createFreeOwnerBillingRuntime(input: {
  db: PlatformDB;
  env: NodeJS.ProcessEnv;
  backgroundWorkersEnabled: boolean;
}): { afterAdmitted?: (clerkUserId: string) => Promise<unknown>; stop: () => Promise<void> } {
  if (!input.env.STRIPE_SECRET_KEY) return { stop: async () => undefined };
  const deps = { db: input.db, stripe: createStripeBillingClient({ secretKey: input.env.STRIPE_SECRET_KEY }) };
  const stop = input.backgroundWorkersEnabled ? startFreeOwnerBillingSweep(deps) : async () => undefined;
  return { afterAdmitted: (clerkUserId) => expireOpenCheckoutsForFreeOwner(deps, clerkUserId), stop };
}
