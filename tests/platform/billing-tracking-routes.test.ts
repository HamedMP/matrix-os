import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBillingTrackingRoutes } from '../../packages/platform/src/billing/tracking-routes.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { enqueueGooglePurchase, deliverGooglePurchases } from '../../packages/platform/src/billing/google-purchase-store.js';
import { invoiceTrackingEvent } from '../../packages/platform/src/billing/tracking-events.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';

const metadata = { matrix_plan_slug: 'matrix_builder', matrix_billing_interval: 'monthly', matrix_trial_days: '3',
  matrix_google_client_id: '123.456', matrix_google_analytics_consent: 'granted', matrix_google_expires_at: '4099680000000' };
const paidInvoice = { id: 'in_123', livemode: true, status: 'paid', billing_reason: 'subscription_cycle', amount_paid: 12000, total: 12000,
  currency: 'usd', total_taxes: [{ amount: 2000 }], parent: { subscription_details: { subscription: 'sub_123', metadata } } };

describe('billing tracking endpoints and durable delivery', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  const session = { id: 'cs_live_123', livemode: true, client_reference_id: 'user_123', mode: 'subscription', status: 'complete', payment_status: 'paid',
    amount_total: 12000, currency: 'usd', invoice: 'in_123', subscription: { id: 'sub_123', status: 'active' },
    total_details: { amount_tax: 2000 }, line_items: { data: [{ price: { id: 'price_builder' } }] } };
  function app(userId: string | null = 'user_123', result: unknown = session) {
    return new Hono().route('/billing', createBillingTrackingRoutes({
      resolveClerkUserId: async () => userId, env: { STRIPE_PRICE_MATRIX_BUILDER_MONTHLY: 'price_builder' },
      stripe: { apiTimeoutMs: 10000, retrieveTrackingCheckout: vi.fn().mockResolvedValue(result) },
    }));
  }
  it('requires authentication and validates IDs', async () => {
    expect((await app(null).request('/billing/checkout-result?session_id=cs_live_123')).status).toBe(401);
    expect((await app().request('/billing/checkout-result?session_id=anything')).status).toBe(400);
  });
  it('rejects another user’s session', async () => {
    expect((await app('user_other').request('/billing/checkout-result?session_id=cs_live_123')).status).toBe(404);
  });
  it('returns only verified payment details, ignoring forged URL amounts', async () => {
    const response = await app().request('/billing/checkout-result?session_id=cs_live_123&amount=999&currency=EUR');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.json()).toMatchObject({ event: { event: 'purchase', amount_paid: 120, ecommerce: { currency: 'USD' } } });
  });
  it('keeps pending payment retryable', async () => {
    expect(await (await app('user_123', { ...session, payment_status: 'unpaid' }).request('/billing/checkout-result?session_id=cs_live_123')).json())
      .toMatchObject({ event: null });
  });
  it.each([false, undefined])('does not expose test or unknown-mode checkout events: %j', async livemode => {
    expect(await (await app('user_123', { ...session, livemode }).request('/billing/checkout-result?session_id=cs_live_123')).json())
      .toEqual({ event: null });
  });
  it('persists a single acquisition per subscription across duplicate webhooks and renewals', async () => {
    const purchase = invoiceTrackingEvent(paidInvoice)!;
    await Promise.all([enqueueGooglePurchase(db, purchase), enqueueGooglePurchase(db, purchase)]);
    await enqueueGooglePurchase(db, { ...purchase, event: { ...purchase.event, ecommerce: { ...purchase.event.ecommerce, transaction_id: 'in_renewal' } } });
    const send = vi.fn().mockResolvedValue('sent');
    await deliverGooglePurchases(db, { send });
    await deliverGooglePurchases(db, { send });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ event: { trial_converted: true } });
  });
  it('retries a failed external delivery without losing the purchase', async () => {
    await enqueueGooglePurchase(db, invoiceTrackingEvent(paidInvoice)!, '2026-10-15T10:00:00.000Z');
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('sent');
    await deliverGooglePurchases(db, { send }, '2026-10-15T10:01:00.000Z');
    await deliverGooglePurchases(db, { send }, '2026-10-15T10:05:00.000Z');
    expect(send).toHaveBeenCalledTimes(2);
  });
});

// The real billing webhook must persist acquisition tracking even when Stripe
// delivers invoice.paid before customer.subscription.created.
describe('Stripe webhook acquisition wiring', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  it('queues the first paid trial invoice once before subscription projection, ignoring renewals', async () => {
    const { createBillingRoutes } = await import('../../packages/platform/src/billing-routes.js');
    const data = { ...paidInvoice, parent: { subscription_details: { subscription: 'sub_123', metadata: {
      ...metadata, clerk_user_id: 'user_123',
    } } } };
    const stripe = { apiTimeoutMs: 10000, constructWebhookEvent: vi.fn()
      .mockReturnValueOnce({ id: 'evt_paid', type: 'invoice.paid', created: 1792065600, data: { object: data } })
      .mockReturnValueOnce({ id: 'evt_paid', type: 'invoice.paid', created: 1792065600, data: { object: data } })
      .mockReturnValueOnce({ id: 'evt_renewal', type: 'invoice.paid', created: 1792065600, data: { object: { ...data, id: 'in_renewal' } } }),
    };
    const app = new Hono().route('/billing', createBillingRoutes({ db,
      stripe: stripe as unknown as Parameters<typeof createBillingRoutes>[0]['stripe'],
      env: { STRIPE_WEBHOOK_SECRET: 'test' }, resolveClerkUserId: async () => 'user_123', now: () => new Date('2026-10-15T12:00:00.000Z'),
    }));
    for (let i = 0; i < 3; i++) {
      const result = await app.request('/billing/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': 'signed' }, body: '{}' });
      expect(result.status).toBe(200);
    }
    const rows = await db.executor.selectFrom('billing_google_purchases').selectAll().execute();
    expect(rows).toHaveLength(1); expect(rows[0].transaction_id).toBe('in_123');
    expect(JSON.parse(rows[0].payload!)).toMatchObject({ event: { trial_converted: true } });
  });
});

describe('parallel Google delivery', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  it('leases prevent two platform workers from sending the same pending purchase', async () => {
    await enqueueGooglePurchase(db, invoiceTrackingEvent(paidInvoice)!);
    const send = vi.fn().mockResolvedValue('sent');
    await Promise.all([deliverGooglePurchases(db, { send }), deliverGooglePurchases(db, { send })]);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('keeps the original attribution snapshot on an ambiguous checkout retry', async () => {
    const { rememberGoogleAttribution } = await import('../../packages/platform/src/billing/google-attribution-store.js');
    const { claimCheckoutAttempt } = await import('../../packages/platform/src/db.js');
    const at = new Date().toISOString();
    const { attempt } = await claimCheckoutAttempt(db, { id: 'tracking_attempt', clerkUserId: 'user_123', runtimeSlot: 'primary', planSlug: 'matrix_builder', billingInterval: 'monthly', regionSlug: 'region_fsn1', createdAt: at });
    const first = { clientId: '123.456', analyticsConsent: 'granted', adUserData: 'denied', adPersonalization: 'denied', expiresAt: Date.now() + 60000 } as const;
    expect(await rememberGoogleAttribution(db, attempt.id, 'user_123', first, at)).toEqual(first);
    expect(await rememberGoogleAttribution(db, attempt.id, 'user_123', { ...first, clientId: '999.000' }, at)).toEqual(first);
  });
});
