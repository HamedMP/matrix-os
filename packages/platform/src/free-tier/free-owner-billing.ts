import { sql } from 'kysely';
import type { PlatformDB } from '../db.js';
import type { StripeBillingClient } from '../billing/stripe-client.js';
import { createStripeBillingClient } from '../stripe-billing.js';
import { freeOwnerPredicate, ownerOnFreePlan } from './free-checkout-guard.js';
import { enqueueCheckoutCompensation, freeOwnerSince, freeOwnerSinceSql, runCheckoutCompensations } from './free-owner-compensation.js';

/**
 * ENG-520 launch guard, layer 2 (review P1): free to paid upgrade (ENG-606)
 * does not exist, so a free owner's open paid Checkout sessions are expired in
 * Stripe, after free admission commits and from a bounded sweep that also
 * covers owners admitted before the guard shipped. A session Stripe reports
 * complete is queued for compensation (free-owner-compensation.ts) in the same
 * transaction that retires its attempt. Stripe is never called inside a
 * database transaction; expiry tolerates sessions already expired or complete.
 */

const SWEEP_BATCH = 25;
const SESSIONS_PER_OWNER = 20;
const SWEEP_INTERVAL_MS = 5 * 60_000;

export interface FreeOwnerBillingDeps {
  db: PlatformDB;
  stripe: Pick<StripeBillingClient, 'expireCheckoutSession' | 'compensateFreeOwnerCheckout'>;
  now?: () => Date;
  captureEvent?: (event: string, options?: { properties?: Record<string, string | number | boolean | undefined> }) => void;
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
  const attempts = await deps.db.executor.selectFrom('billing_checkout_attempts').select(['id', 'stripe_session_id'])
    .where('clerk_user_id', '=', clerkUserId)
    .where('status', 'in', ['creating', 'open'])
    .where('stripe_session_id', 'is not', null)
    .limit(SESSIONS_PER_OWNER)
    .execute();
  let pending = 0;
  for (const { id: attemptId, stripe_session_id: sessionId } of attempts) {
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
    const at = now().toISOString();
    if (session.status === 'expired') {
      await retireFreeOwnerCheckoutAttempt(deps.db, sessionId, 'expired', at);
      continue;
    }
    // Complete: it was paid. Queue its compensation before the attempt stops
    // looking pending, in one transaction, so a webhook handled before this
    // guard shipped still leads to a refund.
    await deps.db.transaction(async (trx) => {
      await enqueueCheckoutCompensation(trx, { stripeSessionId: sessionId, checkoutAttemptId: attemptId, stripeSubscriptionId: null, at });
      await retireFreeOwnerCheckoutAttempt(trx, sessionId, 'abandoned', at, true);
    });
  }
  return pending;
}

/**
 * A checkout this owner paid while already free whose webhook was handled
 * before the guard shipped (the attempt is `paid`): queue its compensation.
 */
async function queuePaidCheckoutsOfFreeOwners(db: PlatformDB, at: Date): Promise<void> {
  const paid = await db.executor.selectFrom('billing_checkout_attempts')
    .select(['id', 'clerk_user_id', 'stripe_session_id', 'created_at'])
    .where('status', '=', 'paid')
    .where('stripe_session_id', 'is not', null)
    .where(freeOwnerPredicate(sql.ref('billing_checkout_attempts.clerk_user_id')))
    .where((eb) => eb.not(eb.exists(eb.selectFrom('billing_free_owner_compensations')
      .select('billing_free_owner_compensations.stripe_checkout_session_id')
      .whereRef('billing_free_owner_compensations.stripe_checkout_session_id', '=', 'billing_checkout_attempts.stripe_session_id'))))
    // Started while free, filtered before the limit so older real purchases never starve blocked ones.
    .where(sql<boolean>`billing_checkout_attempts.created_at::timestamptz >= ${freeOwnerSinceSql(sql.ref('billing_checkout_attempts.clerk_user_id'))}`)
    .orderBy('billing_checkout_attempts.created_at')
    .limit(SWEEP_BATCH)
    .execute();
  const atIso = at.toISOString();
  for (const attempt of paid) {
    if (!attempt.stripe_session_id) continue;
    const since = await freeOwnerSince(db, attempt.clerk_user_id);
    // Only a checkout started while free; an older paid checkout is a former paid owner's real purchase.
    if (!since || Date.parse(attempt.created_at) < since.getTime()) continue;
    const sessionId = attempt.stripe_session_id;
    await db.transaction(async (trx) => {
      await enqueueCheckoutCompensation(trx, { stripeSessionId: sessionId, checkoutAttemptId: attempt.id, stripeSubscriptionId: null, at: atIso });
      await retireFreeOwnerCheckoutAttempt(trx, sessionId, 'abandoned', atIso, true);
    });
  }
}

/** One bounded pass: expire free owners' open sessions, queue paid blocked checkouts, then compensate. */
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
  await queuePaidCheckoutsOfFreeOwners(deps.db, at);
  await runCheckoutCompensations(deps);
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
