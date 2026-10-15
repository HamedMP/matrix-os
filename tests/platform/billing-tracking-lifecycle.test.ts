import { Hono } from 'hono';
import { createApp } from '../../packages/platform/src/main.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { createBillingRoutes } from '../../packages/platform/src/billing-routes.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { enqueueGooglePurchase, expireGoogleTracking } from '../../packages/platform/src/billing/google-purchase-store.js';
import { startGooglePurchaseWorker } from '../../packages/platform/src/billing/google-purchases.js';
import { invoiceTrackingEvent } from '../../packages/platform/src/billing/tracking-events.js';
import { getBillingSubscription, insertUserMachine, listBillingRuntimeActions, upsertBillingSubscription, type PlatformDB } from '../../packages/platform/src/db.js';

const at = '2026-10-15T12:00:00.000Z';
const epoch = Date.parse(at) / 1000;
const invoice = { id: 'in_recovered', livemode: true, status: 'paid', created: epoch, billing_reason: 'subscription_cycle',
  amount_due: 10000, amount_paid: 10000, total: 10000, currency: 'usd', total_taxes: [],
  parent: { subscription_details: { subscription: 'sub_recovered', metadata: {
    clerk_user_id: 'user_recovered', matrix_plan_slug: 'matrix_builder', matrix_billing_interval: 'monthly', matrix_trial_days: '3',
    matrix_google_client_id: '123.456', matrix_google_analytics_consent: 'granted', matrix_google_expires_at: '4099680000000',
  } } },
};
describe('billing tracking lifecycle isolation', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { vi.unstubAllGlobals(); await destroyTestPlatformDb(db); });
  function webhook(stripe: Record<string, unknown>, env: NodeJS.ProcessEnv = {}) {
    return new Hono().route('/billing', createBillingRoutes({ db,
      stripe: { apiTimeoutMs: 10000, constructWebhookEvent: () => ({ id: 'evt_recovered', type: 'invoice.paid', created: epoch, data: { object: invoice } }), ...stripe } as unknown as Parameters<typeof createBillingRoutes>[0]['stripe'],
      env: { STRIPE_WEBHOOK_SECRET: 'test', ...env }, resolveClerkUserId: async () => null, now: () => new Date(at),
    }));
  }
  const request = { method: 'POST', headers: { 'stripe-signature': 'signed' }, body: '{}' };

  it('does not turn a renewal into an acquisition after an excluded first positive payment', async () => {
    const constructWebhookEvent = vi.fn()
      .mockReturnValueOnce({ id: 'evt_partial', type: 'invoice.paid', created: epoch,
        data: { object: { ...invoice, amount_paid: 5000 } } })
      .mockReturnValueOnce({ id: 'evt_renewal', type: 'invoice.paid', created: epoch + 2592000,
        data: { object: { ...invoice, id: 'in_renewal' } } });
    const retrieveTrackingInvoice = vi.fn().mockResolvedValue({ ...invoice, id: 'in_renewal' });
    const send = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', send);
    const app = webhook({ constructWebhookEvent, retrieveTrackingInvoice }, {
      GOOGLE_ANALYTICS_MEASUREMENT_ID: 'G-TEST', GOOGLE_ANALYTICS_API_SECRET: 'test',
    });
    expect((await app.request('/billing/webhooks/stripe', request)).status).toBe(200);
    expect((await app.request('/billing/webhooks/stripe', request)).status).toBe(200);
    expect(await db.executor.selectFrom('billing_google_purchases').selectAll().execute())
      .toEqual([expect.objectContaining({ transaction_id: 'in_recovered', payload: null, sent_at: null })]);
    expect(retrieveTrackingInvoice).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not start background database work when constructing an HTTP app', async () => {
    const transaction = vi.spyOn(db, 'transaction');
    const app = createApp({ db, orchestrator: stubOrchestrator(), env: {} });
    await app.shutdownPostHog();
    expect(transaction).not.toHaveBeenCalled();
    transaction.mockRestore();
  });

  it('does not start a background queue on a request-only replica', async () => {
    const transaction = vi.spyOn(db, 'transaction');
    await startGooglePurchaseWorker(db, {}, false)();
    expect(transaction).not.toHaveBeenCalled();
    transaction.mockRestore();
  });

  it('terminally clears confirmed unsupported invoices without collecting or retrying', async () => {
    const retrieveTrackingInvoice = vi.fn().mockResolvedValue({ ...invoice, payments: { data: [
      { status: 'paid', payment: { payment_intent: 'pi_one' } },
      { status: 'paid', payment: { payment_intent: 'pi_two' } },
    ] } });
    const send = vi.fn();
    vi.stubGlobal('fetch', send);
    const app = webhook({ retrieveTrackingInvoice }, { GOOGLE_ANALYTICS_MEASUREMENT_ID: 'G-TEST', GOOGLE_ANALYTICS_API_SECRET: 'test' });
    expect((await app.request('/billing/webhooks/stripe', request)).status).toBe(200);
    expect((await app.request('/billing/webhooks/stripe', request)).status).toBe(200);
    expect(retrieveTrackingInvoice).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(await db.executor.selectFrom('billing_google_purchases').selectAll().executeTakeFirstOrThrow())
      .toMatchObject({ payload: null, sent_at: null, attempts: 0 });
  });

  it.each(['scheduled', 'completed'] as const)('does not recreate tracking data for an owner with %s deletion', async status => {
    const secret = 'tracking-deletion-secret-at-least-32-bytes';
    await new AccountDeletionRepository(db.kysely, { secret }).accept({ clerkUserId: 'user_recovered', appleTokens: [] }, false);
    if (status === 'completed') await db.executor.updateTable('account_deletion_jobs').set({ status, encrypted_context: null }).execute();
    expect((await webhook({}, { ACCOUNT_DELETION_SECRET: secret }).request('/billing/webhooks/stripe', request)).status).toBe(200);
    expect(await db.executor.selectFrom('billing_google_purchases').selectAll().execute()).toEqual([]);
  });

  it('commits trial recovery before a tracking lookup failure and retries only measurement', async () => {
    await upsertBillingSubscription(db, { stripeSubscriptionId: 'sub_recovered', stripeCustomerId: 'cus_recovered',
      clerkUserId: 'user_recovered', runtimeSlot: 'primary', planSlug: 'matrix_builder', stripePriceId: 'price_builder',
      billingInterval: 'monthly', status: 'past_due', currentPeriodEnd: '2026-11-15T12:00:00.000Z', gracePeriodEndsAt: null,
      trialStartedAt: '2026-10-12T12:00:00.000Z', trialEndsAt: at, trialConvertedAt: null, firstTrialPaymentFailedAt: at,
      latestEventCreatedAt: '2026-10-15T11:59:00.000Z', latestEventId: 'evt_failed', updatedAt: at });
    await insertUserMachine(db, { machineId: 'machine_recovered', clerkUserId: 'user_recovered', handle: 'recovered', runtimeSlot: 'primary',
      hetznerServerId: 123456, publicIPv4: '203.0.113.10', status: 'suspended', imageVersion: 'v1', provisionedAt: at });
    const retrieveTrackingInvoice = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ...invoice,
      payments: { data: [{ status: 'paid', payment: { payment_intent: { amount_received: 10000, currency: 'usd',
        presentment_details: { presentment_amount: 15000, presentment_currency: 'jpy' } } } }] },
    });
    const send = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', send);
    const app = webhook({ retrieveTrackingInvoice }, { GOOGLE_ANALYTICS_MEASUREMENT_ID: 'G-TEST', GOOGLE_ANALYTICS_API_SECRET: 'test' });
    expect((await app.request('/billing/webhooks/stripe', request)).status).toBe(500);
    expect(await getBillingSubscription(db, 'user_recovered', 'primary', at)).toMatchObject({ trialConvertedAt: at });
    expect(await listBillingRuntimeActions(db, 'sub_recovered')).toEqual([expect.objectContaining({ action: 'resume', status: 'queued' })]);
    expect((await app.request('/billing/webhooks/stripe', request)).status).toBe(200);
    expect(retrieveTrackingInvoice).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[0][1].body)).toMatchObject({ events: [{ name: 'purchase', params: { value: 15000, currency: 'JPY' } }] });
    expect((await db.executor.selectFrom('billing_google_purchases').selectAll().executeTakeFirstOrThrow()).payload).toBeNull();
    expect(await listBillingRuntimeActions(db, 'sub_recovered')).toHaveLength(1);
  });

  it('expires stored identity payloads even when Google delivery is disabled', async () => {
    const { claimCheckoutAttempt } = await import('../../packages/platform/src/db.js');
    const { rememberGoogleAttribution } = await import('../../packages/platform/src/billing/google-attribution-store.js');
    const { attempt } = await claimCheckoutAttempt(db, { id: 'old_tracking', clerkUserId: 'user_recovered', runtimeSlot: 'primary',
      planSlug: 'matrix_builder', billingInterval: 'monthly', regionSlug: 'region_fsn1', createdAt: '2020-01-01T00:00:00.000Z' });
    await rememberGoogleAttribution(db, attempt.id, 'user_recovered', undefined, '2020-01-01T00:00:00.000Z');
    await enqueueGooglePurchase(db, invoiceTrackingEvent(invoice)!, '2020-01-01T00:00:00.000Z', 'user_recovered');
    const stop = startGooglePurchaseWorker(db, {}, true);
    await stop();
    expect((await db.executor.selectFrom('billing_google_purchases').selectAll().executeTakeFirstOrThrow()).payload).toBeNull();
    expect(await db.executor.selectFrom('billing_google_checkout_attribution').selectAll().execute()).toEqual([]);
    expect(await expireGoogleTracking(db)).toEqual({ purchases: 0, snapshots: 0 });
  });
});
