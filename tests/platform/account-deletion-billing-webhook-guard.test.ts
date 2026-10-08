import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountDeletionBillingWebhookGuard } from '../../packages/platform/src/account-deletion/billing-webhook-guard.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { upsertBillingCustomer, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import type { StripeWebhookEvent } from '../../packages/platform/src/billing/stripe-client.js';

const owner = 'user_billingguard123';
const secret = 'billing-webhook-guard-secret-at-least-32';
const env = { ACCOUNT_DELETION_SECRET: secret, STRIPE_SECRET_KEY: 'private-test-key', STRIPE_WEBHOOK_SECRET: 'whsec_test' };
describe('signed Stripe webhook deletion guard', () => {
  let db: PlatformDB;
  let event: StripeWebhookEvent;
  let app: Hono;
  const request = vi.fn<typeof fetch>();
  const stripe = { constructWebhookEvent: vi.fn(() => event) };
  const raw = '{ "preserve": "exact signed bytes" }';
  beforeEach(async () => {
    vi.resetAllMocks(); ({ db } = await createTestPlatformDb());
    event = { id: 'evt_guard', type: 'customer.subscription.created', created: 1, data: { object: { id: 'sub_guard', customer: 'cus_guard', status: 'active', metadata: { clerk_user_id: owner } } } };
    stripe.constructWebhookEvent.mockImplementation(() => event);
    await upsertBillingCustomer(db, { clerkUserId: owner, stripeCustomerId: 'cus_guard', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    app = new Hono();
    app.use('/billing/webhooks/stripe', createAccountDeletionBillingWebhookGuard({ db, stripe, env, request }));
    app.post('/billing/webhooks/stripe', bodyLimit({ maxSize: 1024 * 1024 }), async (c) => c.json({ raw: await c.req.text() }));
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  const hook = (body = raw) => app.request('/billing/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': 'valid-signature', 'content-type': 'application/json' }, body });
  const schedule = () => new AccountDeletionRepository(db.kysely, { secret }).accept({ clerkUserId: owner, appleTokens: [] }, false);
  const subscription = (status: string, customer = 'cus_guard') => new Response(JSON.stringify({ id: 'sub_guard', customer, status }), { status: 200 });

  it('preserves raw bytes for normal downstream signature verification and projection', async () => {
    const response = await hook();
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ raw });
    expect(stripe.constructWebhookEvent).toHaveBeenCalledWith(raw, 'valid-signature', 'whsec_test');
    expect(request).not.toHaveBeenCalled();
  });
  it('cancels an active subscription immediately for a scheduled owner and confirms the provider outcome before acknowledgement', async () => {
    await schedule(); request.mockResolvedValueOnce(subscription('active')).mockResolvedValueOnce(subscription('canceled'));
    const response = await hook();
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ received: true, ignored: true });
    expect(request).toHaveBeenNthCalledWith(2, 'https://api.stripe.com/v1/subscriptions/sub_guard', expect.objectContaining({ method: 'DELETE', signal: expect.any(AbortSignal), redirect: 'error' }));
    expect(String(request.mock.calls[1][1]?.body)).toBe('invoice_now=false&prorate=false');
  });
  it('handles delayed metadata-owned checkout subscriptions even after owner billing rows were removed', async () => {
    await schedule(); await db.executor.deleteFrom('billing_customers').execute();
    event = { ...event, type: 'checkout.session.completed', data: { object: { id: 'cs_guard', customer: 'cus_guard', subscription: 'sub_guard', client_reference_id: owner, metadata: { clerk_user_id: owner } } } };
    request.mockResolvedValueOnce(subscription('active')).mockResolvedValueOnce(subscription('canceled'));
    expect((await hook()).status).toBe(200); expect(request).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid signatures and refuses ambiguous owner/customer mappings without calling Stripe', async () => {
    stripe.constructWebhookEvent.mockImplementationOnce(() => { throw new Error('private signature detail'); });
    expect((await hook()).status).toBe(401);
    await schedule();
    await db.executor.updateTable('billing_customers').set({ clerk_user_id: 'user_other' }).execute();
    const response = await hook(); expect(response.status).toBe(503); expect(request).not.toHaveBeenCalled();
  });
  it('retries provider failure with generic errors and refuses cancellation of a different live customer', async () => {
    await schedule(); request.mockResolvedValueOnce(subscription('active', 'cus_other'));
    expect((await hook()).status).toBe(503); expect(request).toHaveBeenCalledTimes(1);
    request.mockReset(); request.mockResolvedValueOnce(subscription('active')).mockResolvedValueOnce(new Response('provider-private-detail', { status: 500 }));
    const response = await hook(); expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'Billing cleanup unavailable' });
  });
  it('acknowledges a repeated event for an already cancelled subscription without another cancellation', async () => {
    await schedule(); request.mockResolvedValueOnce(subscription('canceled'));
    expect((await hook()).status).toBe(200); expect(request).toHaveBeenCalledTimes(1);
  });
  it('limits raw webhook bodies before verification', async () => {
    expect((await hook('x'.repeat(1024 * 1024 + 1))).status).toBe(413);
    expect(stripe.constructWebhookEvent).not.toHaveBeenCalled();
  });
  it('cancels when deletion acceptance races the normal webhook projection', async () => {
    const racing = new Hono();
    racing.use('/billing/webhooks/stripe', createAccountDeletionBillingWebhookGuard({ db, stripe, env, request }));
    racing.post('/billing/webhooks/stripe', async (c) => {
      await schedule(); return c.json({ projected: true });
    });
    request.mockResolvedValueOnce(subscription('active')).mockResolvedValueOnce(subscription('canceled'));
    const response = await racing.request('/billing/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': 'valid-signature' }, body: raw });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ received: true, ignored: true });
    expect(request).toHaveBeenCalledTimes(2);
  });

});
