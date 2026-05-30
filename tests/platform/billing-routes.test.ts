import { Hono } from 'hono';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  getBillingEntitlement,
  insertBillingWebhookEvent,
  upsertBillingCustomer,
  upsertBillingEntitlement,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import {
  createBillingRoutes,
  type StripeBillingClient,
  type StripeWebhookEvent,
} from '../../packages/platform/src/billing-routes.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const env = {
  STRIPE_PRICE_MATRIX_STARTER_MONTHLY: 'price_starter_monthly',
  STRIPE_PRICE_MATRIX_STARTER_ANNUAL: 'price_starter_annual',
  STRIPE_PRICE_MATRIX_BUILDER_MONTHLY: 'price_builder_monthly',
  STRIPE_PRICE_MATRIX_BUILDER_ANNUAL: 'price_builder_annual',
  STRIPE_PRICE_MATRIX_MAX_MONTHLY: 'price_max_monthly',
  STRIPE_PRICE_MATRIX_MAX_ANNUAL: 'price_max_annual',
  STRIPE_PRICE_EXTRA_RUNTIME_MONTHLY: 'price_extra_runtime_monthly',
  STRIPE_PRICE_EXTRA_RUNTIME_ANNUAL: 'price_extra_runtime_annual',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
};

describe('platform billing routes', () => {
  let db: PlatformDB;
  let stripe: StripeBillingClient;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    stripe = {
      apiTimeoutMs: 10_000,
      createCustomer: vi.fn().mockResolvedValue({ id: 'cus_123' }),
      createCheckoutSession: vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.test/session' }),
      createPortalSession: vi.fn().mockResolvedValue({ url: 'https://billing.stripe.test/session' }),
      constructWebhookEvent: vi.fn(),
    };
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function createApp(userId: string | null = 'user_123') {
    const app = new Hono();
    app.route('/billing', createBillingRoutes({
      db,
      stripe,
      env,
      resolveClerkUserId: () => Promise.resolve(userId),
      now: () => new Date('2026-05-30T00:00:00.000Z'),
    }));
    return app;
  }

  it('creates checkout sessions from server-owned plan slugs and omits payment_method_types', async () => {
    const app = createApp();

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planSlug: 'matrix_builder', interval: 'annual' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.test/session' });
    expect(stripe.createCustomer).toHaveBeenCalledWith({
      clerkUserId: 'user_123',
      idempotencyKey: 'billing-customer:user_123',
    });
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cus_123',
      priceId: 'price_builder_annual',
      mode: 'subscription',
      automaticTax: true,
    }));
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ payment_method_types: expect.anything() }),
    );
  });

  it('uses a stable Stripe idempotency key for concurrent customer creation', async () => {
    let customerSequence = 0;
    const idempotentCustomers: Record<string, string | undefined> = {};
    vi.mocked(stripe.createCustomer).mockImplementation(async ({ idempotencyKey }) => {
      const existing = idempotentCustomers[idempotencyKey];
      const id = existing ?? `cus_${++customerSequence}`;
      idempotentCustomers[idempotencyKey] = id;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { id };
    });
    const app = createApp();

    const [first, second] = await Promise.all([
      app.request('/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planSlug: 'matrix_builder', interval: 'monthly' }),
      }),
      app.request('/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planSlug: 'matrix_builder', interval: 'monthly' }),
      }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(stripe.createCustomer).toHaveBeenCalledWith({
      clerkUserId: 'user_123',
      idempotencyKey: 'billing-customer:user_123',
    });
    expect(stripe.createCheckoutSession).toHaveBeenCalledTimes(2);
    expect(stripe.createCheckoutSession).toHaveBeenNthCalledWith(1, expect.objectContaining({
      customerId: 'cus_1',
    }));
    expect(stripe.createCheckoutSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
      customerId: 'cus_1',
    }));
  });

  it('coalesces concurrent customer creation for the same Clerk user', async () => {
    vi.mocked(stripe.createCustomer).mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { id: 'cus_singleflight' };
    });
    const checkoutCustomers: string[] = [];
    vi.mocked(stripe.createCheckoutSession).mockImplementation(async ({ customerId }) => {
      checkoutCustomers.push(customerId);
      return { url: 'https://checkout.stripe.test/session' };
    });
    const app = createApp();

    const [first, second] = await Promise.all([
      app.request('/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planSlug: 'matrix_builder', interval: 'monthly' }),
      }),
      app.request('/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planSlug: 'matrix_builder', interval: 'monthly' }),
      }),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(stripe.createCustomer).toHaveBeenCalledTimes(1);
    expect(new Set(checkoutCustomers).size).toBe(1);
    expect(checkoutCustomers[0]).toBe('cus_singleflight');
  });

  it('terminates unknown billing paths inside the billing namespace', async () => {
    const app = createApp();

    const res = await app.request('/billing/not-a-route', { method: 'POST' });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('rejects unknown checkout plan slugs with a generic validation error', async () => {
    const app = createApp();

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planSlug: 'price_builder_annual', interval: 'annual' }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid request' });
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it.each([
    ['checkout', 'POST', JSON.stringify({ planSlug: 'matrix_builder', interval: 'monthly' })],
    ['portal', 'POST', undefined],
    ['status', 'GET', undefined],
  ] as const)('returns unauthorized when Clerk auth resolution throws on %s', async (path, method, body) => {
    const app = new Hono();
    app.route('/billing', createBillingRoutes({
      db,
      stripe,
      env,
      resolveClerkUserId: async () => {
        throw new Error('jwks unavailable');
      },
      now: () => new Date('2026-05-30T00:00:00.000Z'),
    }));

    const res = await app.request(`/billing/${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body,
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    expect(stripe.createCustomer).not.toHaveBeenCalled();
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
    expect(stripe.createPortalSession).not.toHaveBeenCalled();
  });

  it('rejects checkout when the Stripe client timeout exceeds the API budget', async () => {
    stripe.apiTimeoutMs = 80_000;
    const app = createApp();

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planSlug: 'matrix_builder', interval: 'monthly' }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Billing unavailable' });
    expect(stripe.createCustomer).not.toHaveBeenCalled();
  });

  it('creates customer portal sessions for the signed-in Stripe customer', async () => {
    await upsertBillingCustomer(db, {
      clerkUserId: 'user_123',
      stripeCustomerId: 'cus_123',
      createdAt: '2026-05-30T00:00:00.000Z',
      updatedAt: '2026-05-30T00:00:00.000Z',
    });
    const app = createApp();

    const res = await app.request('/billing/portal', { method: 'POST' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://billing.stripe.test/session' });
    expect(stripe.createPortalSession).toHaveBeenCalledWith({ customerId: 'cus_123' });
  });

  it('rejects portal creation when the Stripe client timeout exceeds the API budget', async () => {
    await upsertBillingCustomer(db, {
      clerkUserId: 'user_123',
      stripeCustomerId: 'cus_123',
      createdAt: '2026-05-30T00:00:00.000Z',
      updatedAt: '2026-05-30T00:00:00.000Z',
    });
    stripe.apiTimeoutMs = 80_000;
    const app = createApp();

    const res = await app.request('/billing/portal', { method: 'POST' });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Billing unavailable' });
    expect(stripe.createPortalSession).not.toHaveBeenCalled();
  });

  it('rejects Stripe webhooks with invalid signatures', async () => {
    vi.mocked(stripe.constructWebhookEvent).mockImplementation(() => {
      throw new Error('bad signature');
    });
    const app = createApp(null);

    const res = await app.request('/billing/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'invalid' },
      body: '{}',
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid webhook' });
  });

  it('processes subscription webhook events idempotently into entitlements', async () => {
    await upsertBillingCustomer(db, {
      clerkUserId: 'user_123',
      stripeCustomerId: 'cus_123',
      createdAt: '2026-05-30T00:00:00.000Z',
      updatedAt: '2026-05-30T00:00:00.000Z',
    });
    const event = subscriptionEvent('evt_123');
    vi.mocked(stripe.constructWebhookEvent).mockReturnValue(event);
    const app = createApp(null);

    const first = await app.request('/billing/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'valid' },
      body: '{}',
    });
    const duplicate = await app.request('/billing/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'valid' },
      body: '{}',
    });

    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ received: true, processed: true });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ received: true, duplicate: true });
    await expect(getBillingEntitlement(db, 'user_123')).resolves.toMatchObject({
      planSlug: 'matrix_max',
      maxRuntimeSlots: 4,
      defaultServerType: 'cpx52',
      allowedServerTypes: ['cpx22', 'cpx32', 'cpx52'],
    });
  });

  it('does not consume webhook event ids when entitlement projection fails', async () => {
    await upsertBillingCustomer(db, {
      clerkUserId: 'user_123',
      stripeCustomerId: 'cus_123',
      createdAt: '2026-05-30T00:00:00.000Z',
      updatedAt: '2026-05-30T00:00:00.000Z',
    });
    const event = subscriptionEvent('evt_retry');
    vi.mocked(stripe.constructWebhookEvent).mockReturnValue(event);
    let shouldFail = true;
    const app = new Hono();
    app.route('/billing', createBillingRoutes({
      db,
      stripe,
      env,
      resolveClerkUserId: () => Promise.resolve(null),
      now: () => new Date('2026-05-30T00:00:00.000Z'),
      upsertEntitlement: async (trx, entitlement) => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('entitlement write timeout');
        }
        await upsertBillingEntitlement(trx, entitlement);
      },
    }));

    const failed = await app.request('/billing/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'valid' },
      body: '{}',
    });
    const retry = await app.request('/billing/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'valid' },
      body: '{}',
    });

    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'Webhook processing failed' });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ received: true, processed: true });
    await expect(getBillingEntitlement(db, 'user_123')).resolves.toMatchObject({
      planSlug: 'matrix_max',
      maxRuntimeSlots: 4,
    });
  });

  it('does not regress entitlements for previously processed event ids', async () => {
    await insertBillingWebhookEvent(db, {
      stripeEventId: 'evt_123',
      eventType: 'customer.subscription.updated',
      createdAtFromStripe: '2026-05-30T00:00:00.000Z',
      processedAt: '2026-05-30T00:00:01.000Z',
      status: 'processed',
      errorCode: null,
    });
    vi.mocked(stripe.constructWebhookEvent).mockReturnValue(subscriptionEvent('evt_123'));
    const app = createApp(null);

    const res = await app.request('/billing/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'valid' },
      body: '{}',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: true });
    await expect(getBillingEntitlement(db, 'user_123')).resolves.toBeUndefined();
  });
});

function subscriptionEvent(id: string): StripeWebhookEvent {
  return {
    id,
    type: 'customer.subscription.updated',
    created: 1_779_753_600,
    data: {
      object: {
        id: 'sub_123',
        customer: 'cus_123',
        status: 'active',
        current_period_end: 1_782_432_000,
        items: {
          data: [
            { price: { id: 'price_max_monthly' }, quantity: 1 },
            { price: { id: 'price_extra_runtime_monthly' }, quantity: 1 },
          ],
        },
      },
    },
  };
}
