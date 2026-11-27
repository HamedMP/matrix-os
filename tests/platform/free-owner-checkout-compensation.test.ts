import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBillingRoutes, type StripeBillingClient, type StripeWebhookEvent } from '../../packages/platform/src/billing-routes.js';
import {
  getBillingEntitlement,
  insertCheckoutAttempt,
  insertUserMachine,
  upsertBillingEntitlement,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import { buildFreeEntitlement } from '../../packages/platform/src/free-tier/free-entitlement.js';
import {
  expireOpenCheckoutsForFreeOwner,
  runFreeOwnerBillingSweep,
} from '../../packages/platform/src/free-tier/free-owner-billing.js';
import { addFreeTierInvite } from '../../packages/platform/src/free-tier/invites.js';
import { createFreeRuntimeProvisioner } from '../../packages/platform/src/free-tier/provision-free-runtime.js';
import { createMetalHostsRepository } from '../../packages/platform/src/substrates/metal-hosts-repository.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

/**
 * ENG-520 launch guard, review P1 (Nima): a free owner's Checkout session opened
 * before the guard can still be paid. Three layers close it:
 * 1. GET /billing/checkout/status never hands a free owner a checkout URL.
 * 2. A free owner's open sessions are expired in Stripe (after free admission
 *    commits, and by a bounded sweep that covers owners admitted earlier).
 * 3. A subscription that still lands for a free owner is never projected into
 *    a paid entitlement; it is queued for cancel and refund, idempotently.
 * Faults detected: a URL or paid entitlement for a free owner, a missed or
 * repeated Stripe call, a sweep that skips earlier owners, and paid owners
 * affected.
 */

const FREE = 'user_freeowner';
const PAID = 'user_paidowner';
const NOW = new Date('2026-11-27T12:00:00.000Z');
const env = {
  STRIPE_PRICE_MATRIX_STARTER_MONTHLY: 'price_starter_monthly',
  STRIPE_PRICE_MATRIX_BUILDER_MONTHLY: 'price_builder_monthly',
  STRIPE_PRICE_MATRIX_MAX_MONTHLY: 'price_max_monthly',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
};

const SECONDS = (at: Date) => Math.floor(at.getTime() / 1000);
/** Free admission happens at NOW (buildFreeEntitlement); a subscription created while free comes a minute later. */
const WHILE_FREE = new Date(NOW.getTime() + 60_000);

function subscriptionEvent(id: string, owner: string, overrides: {
  type?: string; status?: string; subscriptionId?: string; subscriptionCreated?: Date; eventCreated?: Date;
  trialStart?: Date; trialEnd?: Date;
} = {}): StripeWebhookEvent {
  return {
    id,
    type: overrides.type ?? 'customer.subscription.created',
    created: SECONDS(overrides.eventCreated ?? WHILE_FREE),
    data: { object: {
      id: overrides.subscriptionId ?? 'sub_free', customer: `cus_${owner}`, status: overrides.status ?? 'active',
      created: SECONDS(overrides.subscriptionCreated ?? WHILE_FREE),
      ...(overrides.trialStart ? { trial_start: SECONDS(overrides.trialStart) } : {}),
      ...(overrides.trialEnd ? { trial_end: SECONDS(overrides.trialEnd) } : {}),
      current_period_end: Math.floor(NOW.getTime() / 1000) + 30 * 86_400,
      metadata: { clerk_user_id: owner, matrix_region_slug: 'region_fsn1', matrix_runtime_slot: 'primary' },
      items: { data: [{ price: { id: 'price_max_monthly', unit_amount: 20000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }] },
    } },
  };
}

function completedEvent(id: string, owner: string, sessionId: string): StripeWebhookEvent {
  return {
    id, type: 'checkout.session.completed', created: SECONDS(WHILE_FREE),
    data: { object: {
      id: sessionId, created: SECONDS(NOW) + 30, client_reference_id: owner, subscription: 'sub_free', invoice: 'in_first',
      metadata: { clerk_user_id: owner },
    } },
  };
}

function refundEvent(id: string, type: string, refundId: string, status: string): StripeWebhookEvent {
  return { id, type, created: SECONDS(new Date(NOW.getTime() + 7_200_000)), data: { object: { id: refundId, object: 'refund', status } } };
}

function invoicePaidEvent(id: string, subscriptionId: string, type = 'invoice.paid'): StripeWebhookEvent {
  return {
    id, type, created: SECONDS(new Date(NOW.getTime() + 3_600_000)),
    data: { object: {
      id: `in_${id}`, created: SECONDS(NOW), billing_reason: 'subscription_create', amount_due: 20000, amount_paid: 20000,
      currency: 'usd', parent: { subscription_details: { subscription: subscriptionId } },
    } },
  };
}

describe('free owner paid checkout compensation', () => {
  let db: PlatformDB;
  let stripe: StripeBillingClient;
  let expireCheckoutSession: ReturnType<typeof vi.fn>;
  let compensateFreeOwnerCheckout: ReturnType<typeof vi.fn>;
  let webhookEvent: StripeWebhookEvent;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await createMetalHostsRepository(db.kysely).upsert({
      id: 'host-a', name: 'host-a', apiUrl: 'https://host-a.metal.example.test:8443', ingressHost: 'host-a.metal.example.test',
      status: 'active', memoryCapacityMib: 131072, admissionCeilingMib: 114688,
    });
    expireCheckoutSession = vi.fn(async (_id: string) => ({ status: 'expired', url: null, clerkUserId: FREE, priceId: null, regionSlug: null }));
    compensateFreeOwnerCheckout = vi.fn(async () => ({
      subscriptionId: 'sub_free', settled: false, refund: { id: 're_1', status: 'pending' },
    }));
    stripe = {
      apiTimeoutMs: 10_000,
      createCheckoutSession: vi.fn(async () => { throw new Error('unexpected checkout'); }),
      createAiCreditCheckoutSession: vi.fn(),
      expireCheckoutSession,
      compensateFreeOwnerCheckout,
      retrieveCheckoutSession: vi.fn(),
      retrieveRecurringPrice: vi.fn(),
      createPortalSession: vi.fn(),
      constructWebhookEvent: vi.fn(() => webhookEvent),
    } as unknown as StripeBillingClient;
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  async function makeFree(owner = FREE) {
    await upsertBillingEntitlement(db, buildFreeEntitlement(owner, NOW));
    await insertUserMachine(db, {
      machineId: `metal-${owner}`, clerkUserId: owner, handle: owner.replace('user_', ''), status: 'running',
      provisionedAt: NOW.toISOString(), substrate: 'metal', metalHostId: 'host-a',
    });
  }

  const sessionFor = (id: string) => `cs_${id.replace(/-/g, '_')}`;

  async function openAttempt(owner: string, id: string, runtimeSlot = 'primary', createdAt = new Date(NOW.getTime() - 60_000)) {
    await insertCheckoutAttempt(db, { id, clerkUserId: owner, stripeSessionId: sessionFor(id), runtimeSlot, createdAt: createdAt.toISOString() });
    await db.executor.updateTable('billing_checkout_attempts').set({ checkout_url: `https://checkout.stripe.com/c/pay/${sessionFor(id)}` })
      .where('id', '=', id).execute();
  }

  /** A checkout started after the owner joined free (NOW), as in the reproduced bug. */
  async function blockedAttempt(id = 'att_blocked') {
    await openAttempt(FREE, id, 'primary', new Date(NOW.getTime() + 10_000));
  }

  async function attemptStatus(id: string) {
    return (await db.executor.selectFrom('billing_checkout_attempts').select('status').where('id', '=', id).executeTakeFirstOrThrow()).status;
  }

  function routes(owner: string | null) {
    const app = new Hono();
    app.route('/billing', createBillingRoutes({ db, stripe, env, resolveClerkUserId: async () => owner, now: () => NOW }));
    return app;
  }

  async function deliver(event: StripeWebhookEvent) {
    webhookEvent = event;
    const response = await routes(null).request('/billing/webhooks/stripe', {
      method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
    });
    expect(response.status).toBe(200);
    return response.json();
  }

  async function compensations() {
    return db.executor.selectFrom('billing_free_owner_compensations').selectAll().execute();
  }

  describe('layer 1: GET /billing/checkout/status', () => {
    it('never returns a checkout URL to a free owner', async () => {
      await openAttempt(FREE, '11111111-1111-4111-8111-111111111111');
      await makeFree();
      const response = await routes(FREE).request('/billing/checkout/status?attemptId=11111111-1111-4111-8111-111111111111');
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body).toEqual({ code: 'free_upgrade_unavailable', error: 'Upgrades for free computers are coming soon.' });
      expect(JSON.stringify(body)).not.toContain('checkout.stripe.com');
    });

    it('still returns the URL to a paid or new owner', async () => {
      await openAttempt(PAID, '22222222-2222-4222-8222-222222222222');
      const response = await routes(PAID).request('/billing/checkout/status?attemptId=22222222-2222-4222-8222-222222222222');
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_22222222_2222_4222_8222_222222222222' });
    });
  });

  describe('layer 2: expiring a free owner\'s open sessions', () => {
    it('expires each open session once, in every slot, and marks the attempts expired', async () => {
      await openAttempt(FREE, 'att-1');
      await openAttempt(FREE, 'att-2', 'studio');
      await makeFree();
      await expireOpenCheckoutsForFreeOwner({ db, stripe, now: () => NOW }, FREE);
      expect(expireCheckoutSession.mock.calls.map(([id]) => id).sort()).toEqual(['cs_att_1', 'cs_att_2']);
      expect([await attemptStatus('att-1'), await attemptStatus('att-2')]).toEqual(['expired', 'expired']);
      await expireOpenCheckoutsForFreeOwner({ db, stripe, now: () => NOW }, FREE);
      expect(expireCheckoutSession).toHaveBeenCalledTimes(2);
    });

    it('queues compensation for a session Stripe reports complete, in the same step that retires it', async () => {
      await openAttempt(FREE, 'att-done');
      await makeFree();
      expireCheckoutSession.mockResolvedValueOnce({ status: 'complete', url: null, clerkUserId: FREE, priceId: null, regionSlug: null });
      await expireOpenCheckoutsForFreeOwner({ db, stripe, now: () => NOW }, FREE);
      expect(await attemptStatus('att-done')).toBe('abandoned');
      expect(await compensations()).toMatchObject([{ stripe_checkout_session_id: 'cs_att_done', checkout_attempt_id: 'att-done', status: 'pending' }]);
    });

    it('keeps the attempt for a retry when Stripe is unavailable', async () => {
      await openAttempt(FREE, 'att-retry');
      await makeFree();
      expireCheckoutSession.mockRejectedValueOnce(new Error('stripe down'));
      await expireOpenCheckoutsForFreeOwner({ db, stripe, now: () => NOW }, FREE);
      expect(await attemptStatus('att-retry')).toBe('open');
      await expireOpenCheckoutsForFreeOwner({ db, stripe, now: () => NOW }, FREE);
      expect(await attemptStatus('att-retry')).toBe('expired');
    });

    it('does nothing for a paid owner', async () => {
      await openAttempt(PAID, 'att-paid');
      await expireOpenCheckoutsForFreeOwner({ db, stripe, now: () => NOW }, PAID);
      expect(expireCheckoutSession).not.toHaveBeenCalled();
      expect(await attemptStatus('att-paid')).toBe('open');
    });

    it('the sweep covers owners admitted before the guard and skips paid owners', async () => {
      await openAttempt(FREE, 'att-old');
      await makeFree();
      await openAttempt(PAID, 'att-paid');
      await runFreeOwnerBillingSweep({ db, stripe, now: () => NOW });
      expect(expireCheckoutSession.mock.calls.map(([id]) => id)).toEqual(['cs_att_old']);
      expect(await attemptStatus('att-old')).toBe('expired');
      expect(await attemptStatus('att-paid')).toBe('open');
    });

    it('free admission runs the expiry after its transaction commits', async () => {
      await addFreeTierInvite(db, { clerkUserId: FREE, invitedBy: 'ops' });
      const afterAdmitted = vi.fn(async () => {
        // Outside the admission transaction: the stored free entitlement is already visible.
        expect((await getBillingEntitlement(db, FREE))?.source).toBe('free');
      });
      const provisioner = createFreeRuntimeProvisioner({
        db, config: { maxRuntimes: 10, inviteRequired: true }, env: {}, afterAdmitted,
        metal: { provision: async () => ({ error: 'unavailable' as const }) } as never,
      });
      await provisioner.provision({ clerkUserId: FREE, handle: 'freeowner' });
      expect(afterAdmitted).toHaveBeenCalledWith(FREE);
    });
  });

  describe('layer 3: compensating a blocked checkout that was paid anyway', () => {
    async function runtimeActions() {
      return db.executor.selectFrom('billing_runtime_actions').select(['action', 'machine_id']).execute();
    }

    it('compensates only the blocked checkout: subscription held, only its payment refunded, done when the refund succeeds', async () => {
      await makeFree();
      await blockedAttempt();
      // The subscription event often lands before checkout.session.completed.
      expect(await deliver(subscriptionEvent('evt_s1', FREE))).toEqual({ received: true, processed: true });
      expect(await db.executor.selectFrom('billing_subscriptions').select('stripe_subscription_id').execute()).toEqual([]);
      expect(await getBillingEntitlement(db, FREE)).toMatchObject({ source: 'free' });
      expect(await deliver(completedEvent('evt_c1', FREE, 'cs_att_blocked'))).toEqual({ received: true, processed: true });
      expect(await deliver(completedEvent('evt_c1', FREE, 'cs_att_blocked'))).toEqual({ received: true, duplicate: true });
      expect(await attemptStatus('att_blocked')).toBe('abandoned');
      expect(await compensations()).toMatchObject([{
        stripe_checkout_session_id: 'cs_att_blocked', checkout_attempt_id: 'att_blocked', stripe_subscription_id: 'sub_free', status: 'pending',
      }]);

      await runFreeOwnerBillingSweep({ db, stripe, now: () => NOW });
      expect(compensateFreeOwnerCheckout).toHaveBeenCalledTimes(1);
      expect(compensateFreeOwnerCheckout).toHaveBeenCalledWith({ sessionId: 'cs_att_blocked', refundId: null, refundRound: 0 });
      // Accepted is not done: the refund is still pending.
      expect(await compensations()).toMatchObject([{ status: 'refund_pending', refund_id: 're_1', refund_status: 'pending' }]);

      expect(await deliver(refundEvent('evt_r1', 'refund.updated', 're_1', 'succeeded'))).toEqual({ received: true, processed: true });
      expect(await deliver(refundEvent('evt_r1', 'refund.updated', 're_1', 'succeeded'))).toEqual({ received: true, duplicate: true });
      expect(await compensations()).toMatchObject([{ status: 'done', refund_status: 'succeeded' }]);
      await runFreeOwnerBillingSweep({ db, stripe, now: () => new Date(NOW.getTime() + 3_600_000) });
      expect(compensateFreeOwnerCheckout).toHaveBeenCalledTimes(1);
      expect(await getBillingEntitlement(db, FREE)).toMatchObject({ source: 'free' });
    });

    it('polls a pending refund until Stripe reports it succeeded', async () => {
      await makeFree();
      await blockedAttempt();
      await deliver(completedEvent('evt_c1', FREE, 'cs_att_blocked'));
      await runFreeOwnerBillingSweep({ db, stripe, now: () => NOW });
      compensateFreeOwnerCheckout.mockResolvedValueOnce({ subscriptionId: 'sub_free', settled: false, refund: { id: 're_1', status: 'succeeded' } });
      await runFreeOwnerBillingSweep({ db, stripe, now: () => NOW });
      expect(compensateFreeOwnerCheckout).toHaveBeenCalledTimes(1);
      await runFreeOwnerBillingSweep({ db, stripe, now: () => new Date(NOW.getTime() + 31 * 60_000) });
      expect(compensateFreeOwnerCheckout).toHaveBeenLastCalledWith({ sessionId: 'cs_att_blocked', refundId: 're_1', refundRound: 0 });
      expect(await compensations()).toMatchObject([{ status: 'done', refund_status: 'succeeded' }]);
    });

    it('alerts on a failed refund, keeps the row actionable, and retries with a new refund round', async () => {
      const alert = vi.spyOn(console, 'error');
      await makeFree();
      await blockedAttempt();
      await deliver(completedEvent('evt_c1', FREE, 'cs_att_blocked'));
      await runFreeOwnerBillingSweep({ db, stripe, now: () => NOW });
      await deliver(refundEvent('evt_r1', 'refund.failed', 're_1', 'failed'));
      expect(await compensations()).toMatchObject([{ status: 'refund_failed', refund_status: 'failed' }]);
      expect(alert.mock.calls.some(([message]) => String(message).includes('ALERT free owner refund failed'))).toBe(true);
      compensateFreeOwnerCheckout.mockResolvedValueOnce({ subscriptionId: 'sub_free', settled: false, refund: { id: 're_2', status: 'succeeded' } });
      await runFreeOwnerBillingSweep({ db, stripe, now: () => NOW });
      expect(compensateFreeOwnerCheckout).toHaveBeenLastCalledWith({ sessionId: 'cs_att_blocked', refundId: null, refundRound: 1 });
      expect(await compensations()).toMatchObject([{ status: 'done', refund_id: 're_2' }]);
      alert.mockRestore();
    });

    it('queues a checkout whose webhook was handled before the guard shipped, then refunds it', async () => {
      await makeFree();
      await blockedAttempt();
      // Before rollout the normal handler marked the attempt paid.
      await db.executor.updateTable('billing_checkout_attempts').set({ status: 'paid' }).where('id', '=', 'att_blocked').execute();
      await runFreeOwnerBillingSweep({ db, stripe, now: () => NOW });
      expect(await attemptStatus('att_blocked')).toBe('abandoned');
      expect(compensateFreeOwnerCheckout).toHaveBeenCalledWith({ sessionId: 'cs_att_blocked', refundId: null, refundRound: 0 });
      expect(await compensations()).toMatchObject([{ stripe_checkout_session_id: 'cs_att_blocked', status: 'refund_pending' }]);
    });

    it('lets a former paid owner\'s historical subscription flow through the normal handlers only', async () => {
      const yearAgo = new Date(NOW.getTime() - 365 * 86_400_000);
      expect(await deliver(subscriptionEvent('evt_old1', FREE, {
        subscriptionId: 'sub_old', subscriptionCreated: yearAgo, eventCreated: yearAgo,
      }))).toEqual({ received: true, processed: true });
      await makeFree();
      await deliver(subscriptionEvent('evt_old2', FREE, {
        type: 'customer.subscription.updated', subscriptionId: 'sub_old', status: 'canceled', subscriptionCreated: yearAgo,
      }));
      await deliver(invoicePaidEvent('evt_old_inv', 'sub_old'));
      expect(await compensations()).toEqual([]);
      expect(await db.executor.selectFrom('billing_subscriptions').select(['stripe_subscription_id', 'status']).execute())
        .toEqual([{ stripe_subscription_id: 'sub_old', status: 'canceled' }]);
      await runFreeOwnerBillingSweep({ db, stripe, now: () => NOW });
      expect(compensateFreeOwnerCheckout).not.toHaveBeenCalled();
    });

    it('never suspends a free computer for a former trial owner\'s old trial', async () => {
      const monthAgo = new Date(NOW.getTime() - 30 * 86_400_000);
      const trialEnd = new Date(NOW.getTime() - 16 * 86_400_000);
      await deliver(subscriptionEvent('evt_trial1', FREE, {
        subscriptionId: 'sub_trial', status: 'trialing', subscriptionCreated: monthAgo, eventCreated: monthAgo,
        trialStart: monthAgo, trialEnd,
      }));
      await makeFree();
      await deliver(subscriptionEvent('evt_trial2', FREE, {
        type: 'customer.subscription.updated', subscriptionId: 'sub_trial', status: 'canceled', subscriptionCreated: monthAgo,
        trialStart: monthAgo, trialEnd,
      }));
      expect(await runtimeActions()).toEqual([]);
      expect(await getBillingEntitlement(db, FREE)).toMatchObject({ source: 'free', status: 'active' });
      expect(await db.executor.selectFrom('user_machines').select('status').where('machine_id', '=', `metal-${FREE}`)
        .executeTakeFirstOrThrow()).toEqual({ status: 'running' });
      expect(await compensations()).toEqual([]);
    });

    it('never compensates from a checkout that completed before free admission', async () => {
      await openAttempt(FREE, 'att_early');
      await makeFree();
      const early = completedEvent('evt_early', FREE, 'cs_att_early');
      early.created = SECONDS(NOW) - 3_600;
      await deliver(early);
      expect(await compensations()).toEqual([]);
    });

    it('never compensates a completed session that is not one of this owner\'s checkout attempts', async () => {
      await makeFree();
      await deliver(completedEvent('evt_stranger', FREE, 'cs_unknown'));
      expect(await compensations()).toEqual([]);
    });

    it.each(['invoice.paid', 'invoice.payment_succeeded'])('re-arms a finished compensation when %s arrives late', async (type) => {
      await makeFree();
      await blockedAttempt();
      await deliver(completedEvent('evt_c1', FREE, 'cs_att_blocked'));
      compensateFreeOwnerCheckout.mockResolvedValueOnce({ subscriptionId: 'sub_free', settled: true, refund: null });
      await runFreeOwnerBillingSweep({ db, stripe, now: () => NOW });
      expect(await compensations()).toMatchObject([{ status: 'done' }]);
      expect(await deliver(invoicePaidEvent('evt_inv1', 'sub_free', type))).toEqual({ received: true, processed: true });
      expect(await deliver(invoicePaidEvent('evt_inv1', 'sub_free', type))).toEqual({ received: true, duplicate: true });
      expect(await compensations()).toMatchObject([{ status: 'pending' }]);
    });

    it('does not lose a re-arm that lands while a sweep holds the row', async () => {
      await makeFree();
      await blockedAttempt();
      await deliver(completedEvent('evt_c1', FREE, 'cs_att_blocked'));
      compensateFreeOwnerCheckout.mockImplementationOnce(async () => {
        await deliver(invoicePaidEvent('evt_inv_race', 'sub_free'));
        return { subscriptionId: 'sub_free', settled: true, refund: null };
      });
      await runFreeOwnerBillingSweep({ db, stripe, now: () => NOW });
      expect(await compensations()).toMatchObject([{ status: 'pending' }]);
    });

    it('leaves a paid owner\'s subscription projection unchanged', async () => {
      expect(await deliver(subscriptionEvent('evt_p1', PAID, { subscriptionId: 'sub_paid' }))).toEqual({ received: true, processed: true });
      expect(await getBillingEntitlement(db, PAID)).toMatchObject({ source: 'stripe', planSlug: 'matrix_max', status: 'active' });
      expect(await compensations()).toEqual([]);
    });
  });
});
