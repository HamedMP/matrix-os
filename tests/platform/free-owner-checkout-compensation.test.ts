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

function subscriptionEvent(id: string, owner: string, overrides: { type?: string; status?: string; subscriptionId?: string } = {}): StripeWebhookEvent {
  return {
    id,
    type: overrides.type ?? 'customer.subscription.created',
    created: Math.floor(NOW.getTime() / 1000),
    data: { object: {
      id: overrides.subscriptionId ?? 'sub_free', customer: `cus_${owner}`, status: overrides.status ?? 'active',
      current_period_end: Math.floor(NOW.getTime() / 1000) + 30 * 86_400,
      metadata: { clerk_user_id: owner, matrix_region_slug: 'region_fsn1', matrix_runtime_slot: 'primary' },
      items: { data: [{ price: { id: 'price_max_monthly', unit_amount: 20000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }] },
    } },
  };
}

function completedEvent(id: string, owner: string, sessionId: string): StripeWebhookEvent {
  return {
    id, type: 'checkout.session.completed', created: Math.floor(NOW.getTime() / 1000),
    data: { object: { id: sessionId, client_reference_id: owner, subscription: 'sub_free', metadata: { clerk_user_id: owner } } },
  };
}

describe('free owner paid checkout compensation', () => {
  let db: PlatformDB;
  let stripe: StripeBillingClient;
  let expireCheckoutSession: ReturnType<typeof vi.fn>;
  let cancelAndRefundSubscription: ReturnType<typeof vi.fn>;
  let webhookEvent: StripeWebhookEvent;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await createMetalHostsRepository(db.kysely).upsert({
      id: 'host-a', name: 'host-a', apiUrl: 'https://host-a.metal.example.test:8443', ingressHost: 'host-a.metal.example.test',
      status: 'active', memoryCapacityMib: 131072, admissionCeilingMib: 114688,
    });
    expireCheckoutSession = vi.fn(async (_id: string) => ({ status: 'expired', url: null, clerkUserId: FREE, priceId: null, regionSlug: null }));
    cancelAndRefundSubscription = vi.fn(async () => undefined);
    stripe = {
      apiTimeoutMs: 10_000,
      createCheckoutSession: vi.fn(async () => { throw new Error('unexpected checkout'); }),
      createAiCreditCheckoutSession: vi.fn(),
      expireCheckoutSession,
      cancelAndRefundSubscription,
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

  async function openAttempt(owner: string, id: string, runtimeSlot = 'primary') {
    await insertCheckoutAttempt(db, { id, clerkUserId: owner, stripeSessionId: `cs_${id}`, runtimeSlot, createdAt: new Date(NOW.getTime() - 60_000).toISOString() });
    await db.executor.updateTable('billing_checkout_attempts').set({ checkout_url: `https://checkout.stripe.com/c/pay/cs_${id}` })
      .where('id', '=', id).execute();
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
      expect(await response.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_22222222-2222-4222-8222-222222222222' });
    });
  });

  describe('layer 2: expiring a free owner\'s open sessions', () => {
    it('expires each open session once, in every slot, and marks the attempts expired', async () => {
      await openAttempt(FREE, 'att-1');
      await openAttempt(FREE, 'att-2', 'studio');
      await makeFree();
      await expireOpenCheckoutsForFreeOwner({ db, stripe, now: () => NOW }, FREE);
      expect(expireCheckoutSession.mock.calls.map(([id]) => id).sort()).toEqual(['cs_att-1', 'cs_att-2']);
      expect([await attemptStatus('att-1'), await attemptStatus('att-2')]).toEqual(['expired', 'expired']);
      await expireOpenCheckoutsForFreeOwner({ db, stripe, now: () => NOW }, FREE);
      expect(expireCheckoutSession).toHaveBeenCalledTimes(2);
    });

    it('treats an already completed session as done and leaves no pending attempt', async () => {
      await openAttempt(FREE, 'att-done');
      await makeFree();
      expireCheckoutSession.mockResolvedValueOnce({ status: 'complete', url: null, clerkUserId: FREE, priceId: null, regionSlug: null });
      await expireOpenCheckoutsForFreeOwner({ db, stripe, now: () => NOW }, FREE);
      expect(await attemptStatus('att-done')).toBe('abandoned');
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
      expect(expireCheckoutSession.mock.calls.map(([id]) => id)).toEqual(['cs_att-old']);
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

  describe('layer 3: a subscription that lands for a free owner', () => {
    it('is never projected into a paid entitlement and is queued once for cancel and refund', async () => {
      await openAttempt(FREE, 'att-paid-late');
      await makeFree();
      expect(await deliver(completedEvent('evt_c1', FREE, 'cs_att-paid-late'))).toMatchObject({ received: true });
      expect(await deliver(subscriptionEvent('evt_s1', FREE))).toMatchObject({ received: true });
      expect(await deliver(subscriptionEvent('evt_s1', FREE))).toEqual({ received: true, duplicate: true });
      expect(await deliver(subscriptionEvent('evt_s2', FREE, { type: 'customer.subscription.updated' }))).toMatchObject({ received: true });

      expect(await getBillingEntitlement(db, FREE)).toMatchObject({ source: 'free' });
      expect(await db.executor.selectFrom('billing_subscriptions').select('stripe_subscription_id').execute()).toEqual([]);
      expect(await attemptStatus('att-paid-late')).toBe('abandoned');
      expect(await compensations()).toMatchObject([{ stripe_subscription_id: 'sub_free', status: 'pending' }]);
      expect(cancelAndRefundSubscription).not.toHaveBeenCalled();

      await runFreeOwnerBillingSweep({ db, stripe, now: () => NOW });
      await runFreeOwnerBillingSweep({ db, stripe, now: () => NOW });
      expect(cancelAndRefundSubscription).toHaveBeenCalledTimes(1);
      expect(cancelAndRefundSubscription).toHaveBeenCalledWith('sub_free');
      expect(await compensations()).toMatchObject([{ stripe_subscription_id: 'sub_free', status: 'done' }]);
    });

    it('retries a failed cancel and refund on the next sweep', async () => {
      await makeFree();
      await deliver(subscriptionEvent('evt_s1', FREE));
      cancelAndRefundSubscription.mockRejectedValueOnce(new Error('stripe down'));
      await runFreeOwnerBillingSweep({ db, stripe, now: () => NOW });
      expect(await compensations()).toMatchObject([{ status: 'pending', attempts: 1 }]);
      await runFreeOwnerBillingSweep({ db, stripe, now: () => new Date(NOW.getTime() + 10 * 60_000) });
      expect(await compensations()).toMatchObject([{ status: 'done' }]);
      expect(cancelAndRefundSubscription).toHaveBeenCalledTimes(2);
    });

    it('leaves a paid owner\'s subscription projection unchanged', async () => {
      expect(await deliver(subscriptionEvent('evt_p1', PAID, { subscriptionId: 'sub_paid' }))).toEqual({ received: true, processed: true });
      expect(await getBillingEntitlement(db, PAID)).toMatchObject({ source: 'stripe', planSlug: 'matrix_max', status: 'active' });
      expect(await compensations()).toEqual([]);
    });
  });
});
