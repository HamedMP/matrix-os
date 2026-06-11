import { Hono } from 'hono';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  getBillingEntitlement,
  getBillingCustomerByClerkUserId,
  insertBillingWebhookEvent,
  upsertBillingOverride,
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
      createCheckoutSession: vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.test/session', id: 'cs_test_session' }),
      createPortalSession: vi.fn().mockResolvedValue({ url: 'https://billing.stripe.test/session' }),
      constructWebhookEvent: vi.fn(),
    };
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function createApp(userId: string | null = 'user_123', routeEnv: NodeJS.ProcessEnv = env) {
    const app = new Hono();
    app.route('/billing', createBillingRoutes({
      db,
      stripe,
      env: routeEnv,
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
      body: JSON.stringify({ planSlug: 'matrix_builder', interval: 'annual', regionSlug: 'region_nbg1' }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.test/session' });
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      clerkUserId: 'user_123',
      customerId: undefined,
      priceId: 'price_builder_annual',
      mode: 'subscription',
      automaticTax: true,
      allowPromotionCodes: true,
      regionSlug: 'region_nbg1',
      successUrl: 'https://app.matrix-os.com/?billing=success&checkout=success',
      cancelUrl: 'https://app.matrix-os.com/?billing=canceled',
    }));
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ payment_method_types: expect.anything() }),
    );
  });

  it('creates the default pre-VPS checkout session from the Builder monthly price', async () => {
    const app = createApp();

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planSlug: 'matrix_builder', interval: 'monthly', regionSlug: 'region_fsn1' }),
    });

    expect(res.status).toBe(200);
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      priceId: 'price_builder_monthly',
      regionSlug: 'region_fsn1',
    }));
  });

  it('returns a generic allowlisted code when checkout price config is missing', async () => {
    const app = createApp('user_123', { STRIPE_WEBHOOK_SECRET: 'whsec_test' } as NodeJS.ProcessEnv);

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planSlug: 'matrix_builder', interval: 'monthly' }),
    });

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: 'Billing unavailable',
      code: 'billing_unavailable',
    });
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('uses a validated same-origin returnPath for checkout return URLs', async () => {
    const app = createApp();

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        returnPath: '/auth/device?user_code=BCDF-GHJK',
      }),
    });

    expect(res.status).toBe(200);
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      successUrl: 'https://app.matrix-os.com/auth/device?user_code=BCDF-GHJK&billing=success&checkout=success',
      cancelUrl: 'https://app.matrix-os.com/auth/device?user_code=BCDF-GHJK&billing=canceled',
    }));
  });

  it('resolves a safe checkout returnPath against the configured app origin', async () => {
    const app = createApp('user_123', {
      ...env,
      NEXT_PUBLIC_MATRIX_APP_URL: 'https://staging.matrix-os.com',
    });

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        returnPath: '/auth/device?user_code=BCDF-GHJK',
      }),
    });

    expect(res.status).toBe(200);
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      successUrl: 'https://staging.matrix-os.com/auth/device?user_code=BCDF-GHJK&billing=success&checkout=success',
      cancelUrl: 'https://staging.matrix-os.com/auth/device?user_code=BCDF-GHJK&billing=canceled',
    }));
  });

  it('prefers a safe checkout returnPath over configured checkout return URLs', async () => {
    const app = createApp('user_123', {
      ...env,
      STRIPE_CHECKOUT_SUCCESS_URL: 'https://app.matrix-os.com/after-success',
      STRIPE_CHECKOUT_CANCEL_URL: 'https://app.matrix-os.com/after-cancel',
    });

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        returnPath: '/auth/device?user_code=BCDF-GHJK',
      }),
    });

    expect(res.status).toBe(200);
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      successUrl: 'https://app.matrix-os.com/auth/device?user_code=BCDF-GHJK&billing=success&checkout=success',
      cancelUrl: 'https://app.matrix-os.com/auth/device?user_code=BCDF-GHJK&billing=canceled',
    }));
  });

  it.each([
    ['external URL', 'https://evil.example/auth/device?user_code=BCDF-GHJK'],
    ['protocol-relative URL', '//evil.example/auth/device?user_code=BCDF-GHJK'],
    ['missing leading slash', 'auth/device?user_code=BCDF-GHJK'],
    ['oversized path', `/${'x'.repeat(2049)}`],
  ])('rejects unsafe checkout returnPath values: %s', async (_label, returnPath) => {
    const app = createApp();

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        returnPath,
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid request' });
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('reuses an existing Stripe customer link when one is already known', async () => {
    await upsertBillingCustomer(db, {
      clerkUserId: 'user_123',
      stripeCustomerId: 'cus_existing',
      createdAt: '2026-05-30T00:00:00.000Z',
      updatedAt: '2026-05-30T00:00:00.000Z',
    });
    const app = createApp();

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planSlug: 'matrix_builder', interval: 'monthly' }),
    });

    expect(res.status).toBe(200);
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      clerkUserId: 'user_123',
      customerId: 'cus_existing',
    }));
  });

  it('lets Stripe create customers during checkout when no customer link exists yet', async () => {
    const checkoutCustomerIds: Array<string | undefined> = [];
    vi.mocked(stripe.createCheckoutSession).mockImplementation(async ({ customerId }) => {
      checkoutCustomerIds.push(customerId);
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
    expect(stripe.createCheckoutSession).toHaveBeenCalledTimes(2);
    expect(checkoutCustomerIds).toEqual([undefined, undefined]);
  });

  it('terminates unknown billing paths inside the billing namespace', async () => {
    const app = createApp();

    const res = await app.request('/billing/not-a-route', { method: 'POST' });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
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
    expect(await res.json()).toEqual({
      error: 'Billing unavailable',
      code: 'billing_unavailable',
    });
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
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
    expect(stripe.createPortalSession).toHaveBeenCalledWith({
      customerId: 'cus_123',
      returnUrl: 'https://app.matrix-os.com/?billing=portal',
    });
  });

  it('reports active access from internal billing overrides', async () => {
    await upsertBillingOverride(db, {
      id: 'override_internal',
      clerkUserId: 'user_123',
      planSlug: 'internal',
      status: 'active',
      maxRuntimeSlots: 3,
      includedRuntimeSlots: 3,
      addonRuntimeSlots: 0,
      defaultServerType: 'cpx52',
      allowedServerTypes: ['cpx22', 'cpx32', 'cpx52'],
      reason: 'internal engineer access',
      createdBy: 'test',
      expiresAt: null,
      revokedAt: null,
      createdAt: '2026-05-30T00:00:00.000Z',
    });
    const app = createApp();

    const res = await app.request('/billing/status', { method: 'GET' });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      entitlement: {
        source: 'override',
        planSlug: 'internal',
        status: 'active',
        maxRuntimeSlots: 3,
        defaultServerType: 'cpx52',
      },
      access: {
        runtimeProxyAllowed: true,
        reason: 'active',
      },
    });
  });

  it('returns the generic unavailable code when billing status lookup fails', async () => {
    const app = createApp();
    await destroyTestPlatformDb(db);

    const res = await app.request('/billing/status', { method: 'GET' });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'Billing unavailable',
      code: 'billing_unavailable',
    });
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
    expect(await res.json()).toEqual({
      error: 'Billing unavailable',
      code: 'billing_unavailable',
    });
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

  it('links Stripe-created checkout customers from subscription metadata', async () => {
    const event = subscriptionEvent('evt_metadata_link');
    vi.mocked(stripe.constructWebhookEvent).mockReturnValue(event);
    const app = createApp(null);

    const res = await app.request('/billing/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'valid' },
      body: '{}',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, processed: true });
    await expect(getBillingEntitlement(db, 'user_123')).resolves.toMatchObject({
      planSlug: 'matrix_max',
      stripeSubscriptionId: 'sub_123',
    });
    await expect(getBillingCustomerByClerkUserId(db, 'user_123')).resolves.toMatchObject({
      stripeCustomerId: 'cus_123',
      createdAt: '2026-05-30T00:00:00.000Z',
      updatedAt: '2026-05-30T00:00:00.000Z',
    });
  });

  it('updates stale customer links when a signed subscription webhook names a newer Stripe customer', async () => {
    await upsertBillingCustomer(db, {
      clerkUserId: 'user_123',
      stripeCustomerId: 'cus_old',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    });
    const event = subscriptionEvent('evt_customer_conflict');
    (event.data.object as { customer: string }).customer = 'cus_new';
    vi.mocked(stripe.constructWebhookEvent).mockReturnValue(event);
    const app = createApp(null);

    const res = await app.request('/billing/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'valid' },
      body: '{}',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, processed: true });
    await expect(getBillingEntitlement(db, 'user_123')).resolves.toMatchObject({
      planSlug: 'matrix_max',
      stripeSubscriptionId: 'sub_123',
    });
    await expect(getBillingCustomerByClerkUserId(db, 'user_123')).resolves.toMatchObject({
      stripeCustomerId: 'cus_new',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-30T00:00:00.000Z',
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
        metadata: {
          clerk_user_id: 'user_123',
          matrix_region_slug: 'region_fsn1',
        },
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
