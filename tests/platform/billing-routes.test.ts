import { Hono } from 'hono';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  claimBillingRuntimeAction,
  completeBillingRuntimeAction,
  enqueueBillingRuntimeAction,
  getBillingEntitlement,
  getBillingSubscription,
  getBillingCustomerByClerkUserId,
  getLatestCheckoutAttempt,
  insertUserMachine,
  listBillingRuntimeActions,
  insertCheckoutAttempt,
  insertBillingWebhookEvent,
  upsertBillingOverride,
  upsertBillingCustomer,
  upsertBillingEntitlement,
  upsertBillingSubscription,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import {
  createBillingRoutes,
  type StripeBillingClient,
  type StripeWebhookEvent,
} from '../../packages/platform/src/billing-routes.js';
import { MATRIX_TELEMETRY_EVENTS } from '../../packages/observability/src/events.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const env = {
  STRIPE_PRICE_MATRIX_STARTER_MONTHLY: 'price_starter_monthly',
  STRIPE_PRICE_MATRIX_STARTER_ANNUAL: 'price_starter_annual',
  STRIPE_PRICE_MATRIX_BUILDER_MONTHLY: 'price_builder_monthly',
  STRIPE_PRICE_MATRIX_BUILDER_ANNUAL: 'price_builder_annual',
  STRIPE_PRICE_MATRIX_MAX_MONTHLY: 'price_max_monthly',
  STRIPE_PRICE_MATRIX_MAX_ANNUAL: 'price_max_annual',
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
      retrieveCheckoutSession: vi.fn().mockRejectedValue(new Error('unexpected checkout retrieval')),
      createPortalSession: vi.fn().mockResolvedValue({ url: 'https://billing.stripe.test/session' }),
      constructWebhookEvent: vi.fn(),
    };
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function createApp(
    userId: string | null = 'user_123',
    routeEnv: NodeJS.ProcessEnv = env,
    captureEvent?: Parameters<typeof createBillingRoutes>[0]['captureEvent'],
    now: () => Date = () => new Date('2026-05-30T00:00:00.000Z'),
  ) {
    const app = new Hono();
    app.route('/billing', createBillingRoutes({
      db,
      stripe,
      env: routeEnv,
      resolveClerkUserId: () => Promise.resolve(userId),
      now,
      captureEvent,
    }));
    return app;
  }

  it('creates checkout sessions from server-owned plan slugs and omits payment_method_types', async () => {
    const app = createApp();

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'annual',
        regionSlug: 'region_nbg1',
        runtimeSlot: 'studio',
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.test/session' });
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: expect.any(String),
      clerkUserId: 'user_123',
      customerId: undefined,
      priceId: 'price_builder_annual',
      mode: 'subscription',
      automaticTax: true,
      allowPromotionCodes: true,
      regionSlug: 'region_nbg1',
      runtimeSlot: 'studio',
      successUrl: 'https://app.matrix-os.com/?billing=success&checkout=success',
      cancelUrl: 'https://app.matrix-os.com/?billing=canceled',
    }));
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ payment_method_types: expect.anything() }),
    );
  });

  it('starts admitted preparation after Stripe opens and before checkout returns', async () => {
    const order: string[] = [];
    const prebilling = {
      createIntent: vi.fn(async () => {
        order.push('intent');
        return { intentId: 'intent_123', expiresAt: '2026-05-30T00:30:00.000Z' };
      }),
      startPreparation: vi.fn(async () => {
        order.push('preparation');
      }),
      authorizeSubscription: vi.fn(),
      expireCheckout: vi.fn(),
    };
    vi.mocked(stripe.createCheckoutSession).mockImplementation(async () => {
      order.push('stripe');
      return {
        url: 'https://checkout.stripe.test/session',
        id: 'cs_test_session',
        expiresAt: '2026-05-30T00:30:00.000Z',
      };
    });
    const app = new Hono();
    app.route('/billing', createBillingRoutes({
      db,
      stripe,
      env,
      resolveClerkUserId: () => Promise.resolve('user_123'),
      now: () => new Date('2026-05-30T00:00:00.000Z'),
      prebilling,
    }));

    const response = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        regionSlug: 'region_fsn1',
        runtimeSlot: 'primary',
        developerTools: ['codex', 'pi'],
      }),
    });

    expect(response.status).toBe(200);
    expect(order).toEqual(['intent', 'stripe', 'preparation']);
    expect(prebilling.createIntent).toHaveBeenCalledWith(expect.objectContaining({
      checkoutAttemptId: expect.any(String),
      clerkUserId: 'user_123',
      serverType: 'cpx32',
      developerTools: ['codex', 'pi'],
    }));
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      prebillingIntentId: 'intent_123',
      expiresAt: '2026-05-30T00:30:00.000Z',
    }));
    expect(prebilling.startPreparation).toHaveBeenCalledWith({
      intentId: 'intent_123',
      stripeSessionId: 'cs_test_session',
      stripeSessionExpiresAt: '2026-05-30T00:30:00.000Z',
    });
  });

  it('captures checkout growth funnel events with low-cardinality properties', async () => {
    const captureEvent = vi.fn();
    const app = createApp('user_123', env, captureEvent);

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'annual',
        regionSlug: 'region_nbg1',
        returnPath: '/auth/device?user_code=BCDF-GHJK',
      }),
    });

    expect(res.status).toBe(200);
    expect(captureEvent).toHaveBeenCalledWith(MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_STARTED, {
      distinctId: 'user_123',
      properties: expect.objectContaining({
        plan_slug: 'matrix_builder',
        billing_interval: 'annual',
        region_slug: 'region_nbg1',
        return_path_present: true,
        price_usd: 190,
      }),
    });
    expect(captureEvent).toHaveBeenCalledWith(MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_CREATED, {
      distinctId: 'user_123',
      properties: expect.objectContaining({
        plan_slug: 'matrix_builder',
        billing_interval: 'annual',
        region_slug: 'region_nbg1',
        price_usd: 190,
      }),
    });
    expect(JSON.stringify(captureEvent.mock.calls)).not.toContain('cs_test_session');
    expect(JSON.stringify(captureEvent.mock.calls)).not.toContain('BCDF-GHJK');
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

  it('offers and persists a seven-day trial for the first primary computer', async () => {
    const trialEnv = { ...env, MATRIX_CARD_TRIALS_ENABLED: 'true' };
    const app = createApp('user_123', trialEnv);

    const status = await app.request('/billing/status?runtimeSlot=primary');
    await expect(status.json()).resolves.toMatchObject({
      trialOffer: { eligible: true, durationDays: 7 },
    });

    const checkout = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        regionSlug: 'region_fsn1',
        runtimeSlot: 'primary',
      }),
    });

    expect(checkout.status).toBe(200);
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      trialPeriodDays: 7,
      paymentMethodMode: 'card_required',
    }));
    await expect(getLatestCheckoutAttempt(db, 'user_123')).resolves.toMatchObject({
      runtimeSlot: 'primary',
      trialPeriodDays: 7,
    });
  });

  it('offers and persists the configured card-trial duration', async () => {
    const trialEnv = {
      ...env,
      MATRIX_CARD_TRIALS_ENABLED: 'true',
      MATRIX_CARD_TRIAL_DAYS: '1',
    };
    const app = createApp('user_123', trialEnv);

    const status = await app.request('/billing/status?runtimeSlot=primary');
    await expect(status.json()).resolves.toMatchObject({
      trialOffer: { eligible: true, durationDays: 1 },
    });

    const checkout = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        regionSlug: 'region_fsn1',
        runtimeSlot: 'primary',
      }),
    });

    expect(checkout.status).toBe(200);
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      trialPeriodDays: 1,
      paymentMethodMode: 'card_required',
    }));
    await expect(getLatestCheckoutAttempt(db, 'user_123')).resolves.toMatchObject({
      runtimeSlot: 'primary',
      trialPeriodDays: 1,
    });
  });

  it.each(['open', 'creating'] as const)(
    'keeps status copy aligned with a reserved trial in %s state after the configured duration changes',
    async (attemptStatus) => {
      if (attemptStatus === 'creating') {
        stripe.createCheckoutSession = vi.fn().mockRejectedValue(new Error('stripe response timeout'));
      }
      const sevenDayApp = createApp('user_123', {
        ...env,
        MATRIX_CARD_TRIALS_ENABLED: 'true',
        MATRIX_CARD_TRIAL_DAYS: '7',
      });
      const checkout = await sevenDayApp.request('/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          planSlug: 'matrix_builder',
          interval: 'monthly',
          regionSlug: 'region_fsn1',
          runtimeSlot: 'primary',
        }),
      });
      expect(checkout.status).toBe(attemptStatus === 'open' ? 200 : 503);
      await expect(getLatestCheckoutAttempt(db, 'user_123')).resolves.toMatchObject({
        status: attemptStatus,
        trialPeriodDays: 7,
      });

      const oneDayApp = createApp('user_123', {
        ...env,
        MATRIX_CARD_TRIALS_ENABLED: 'true',
        MATRIX_CARD_TRIAL_DAYS: '1',
      });
      const status = await oneDayApp.request('/billing/status?runtimeSlot=primary');

      await expect(status.json()).resolves.toMatchObject({
        trialOffer: { eligible: true, durationDays: 7 },
      });
    },
  );

  it('keeps status copy aligned with a reserved trial after the rollout flag is disabled', async () => {
    const trialApp = createApp('user_123', {
      ...env,
      MATRIX_CARD_TRIALS_ENABLED: 'true',
      MATRIX_CARD_TRIAL_DAYS: '7',
    });
    const checkout = await trialApp.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        regionSlug: 'region_fsn1',
        runtimeSlot: 'primary',
      }),
    });
    expect(checkout.status).toBe(200);

    const disabledApp = createApp('user_123', {
      ...env,
      MATRIX_CARD_TRIALS_ENABLED: 'false',
      MATRIX_CARD_TRIAL_DAYS: '1',
    });
    const status = await disabledApp.request('/billing/status?runtimeSlot=primary');

    await expect(status.json()).resolves.toMatchObject({
      trialOffer: { eligible: true, durationDays: 7 },
    });
  });

  it('keeps an active immediate-payment Checkout ineligible when trials are later enabled', async () => {
    const immediateApp = createApp('user_123', {
      ...env,
      MATRIX_CARD_TRIALS_ENABLED: 'false',
    });
    const checkout = await immediateApp.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        regionSlug: 'region_fsn1',
        runtimeSlot: 'primary',
      }),
    });
    expect(checkout.status).toBe(200);

    const trialApp = createApp('user_123', {
      ...env,
      MATRIX_CARD_TRIALS_ENABLED: 'true',
      MATRIX_CARD_TRIAL_DAYS: '1',
    });
    const status = await trialApp.request('/billing/status?runtimeSlot=primary');

    await expect(status.json()).resolves.toMatchObject({
      trialOffer: { eligible: false, durationDays: 1 },
    });
  });

  it.each(['0', '31', '1e1', '0x0a', ' 1 ', '18446744073709551623'])(
    'rejects invalid card-trial duration %j during route startup',
    (trialDays) => {
      expect(() => createApp('user_123', {
        ...env,
        MATRIX_CARD_TRIAL_DAYS: trialDays,
      })).toThrow('MATRIX_CARD_TRIAL_DAYS must be an integer from 1 to 30');
    },
  );

  it('does not offer a trial for additional computers or accounts with subscription history', async () => {
    const trialEnv = { ...env, MATRIX_CARD_TRIALS_ENABLED: 'true' };
    const additionalApp = createApp('user_123', trialEnv);
    const additional = await additionalApp.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        regionSlug: 'region_fsn1',
        runtimeSlot: 'studio',
      }),
    });
    expect(additional.status).toBe(200);
    expect(stripe.createCheckoutSession).toHaveBeenLastCalledWith(expect.objectContaining({
      trialPeriodDays: null,
      paymentMethodMode: 'dynamic',
    }));

    await upsertBillingSubscription(db, {
      stripeSubscriptionId: 'sub_history',
      stripeCustomerId: 'cus_history',
      clerkUserId: 'user_history',
      runtimeSlot: 'archive',
      planSlug: 'matrix_starter',
      stripePriceId: 'price_starter_monthly',
      billingInterval: 'monthly',
      status: 'canceled',
      currentPeriodEnd: '2026-05-01T00:00:00.000Z',
      gracePeriodEndsAt: null,
      trialStartedAt: '2026-04-24T00:00:00.000Z',
      trialEndsAt: '2026-05-01T00:00:00.000Z',
      trialConvertedAt: null,
      firstTrialPaymentFailedAt: null,
      latestEventCreatedAt: '2026-05-01T00:00:00.000Z',
      latestEventId: 'evt_history',
      updatedAt: '2026-05-01T00:00:00.000Z',
    });
    const historyApp = createApp('user_history', trialEnv);
    const historyStatus = await historyApp.request('/billing/status?runtimeSlot=primary');
    await expect(historyStatus.json()).resolves.toMatchObject({
      trialOffer: { eligible: false, durationDays: 7 },
    });
  });

  it('returns a generic allowlisted code when checkout price config is missing', async () => {
    const captureEvent = vi.fn();
    const app = createApp('user_123', { STRIPE_WEBHOOK_SECRET: 'whsec_test' } as NodeJS.ProcessEnv, captureEvent);

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
    expect(captureEvent).toHaveBeenCalledWith(MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_FAILED, {
      distinctId: 'user_123',
      properties: expect.objectContaining({
        plan_slug: 'matrix_builder',
        billing_interval: 'monthly',
        failure_code: 'missing_price_config',
        http_status: 503,
      }),
    });
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

  it('claims one active checkout per runtime slot when concurrent requests have no customer yet', async () => {
    const checkoutCustomerIds: Array<string | undefined> = [];
    const idempotencyKeys: string[] = [];
    vi.mocked(stripe.createCheckoutSession).mockImplementation(async ({ customerId, idempotencyKey }) => {
      checkoutCustomerIds.push(customerId);
      idempotencyKeys.push(idempotencyKey);
      return { url: 'https://checkout.stripe.test/session', id: 'cs_concurrent' };
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

    expect([first.status, second.status].sort()).toEqual([200, 200]);
    expect(stripe.createCheckoutSession).toHaveBeenCalledTimes(2);
    expect(checkoutCustomerIds).toEqual([undefined, undefined]);
    expect(new Set(idempotencyKeys).size).toBe(1);
  });

  it('reuses the stored checkout URL for a repeated slot and selection', async () => {
    const app = createApp();
    const request = () => app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        regionSlug: 'region_fsn1',
        runtimeSlot: 'studio',
      }),
    });

    const first = await request();
    const repeated = await request();

    expect(first.status).toBe(200);
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toEqual({ url: 'https://checkout.stripe.test/session' });
    expect(stripe.createCheckoutSession).toHaveBeenCalledOnce();
  });

  it('retries an ambiguous Checkout failure with the same persisted idempotency key', async () => {
    const idempotencyKeys: string[] = [];
    vi.mocked(stripe.createCheckoutSession)
      .mockImplementationOnce(async (input) => {
        idempotencyKeys.push(input.idempotencyKey);
        throw new Error('stripe response timeout');
      })
      .mockImplementationOnce(async (input) => {
        idempotencyKeys.push(input.idempotencyKey);
        return { url: 'https://checkout.stripe.test/recovered', id: 'cs_recovered' };
      });
    const app = createApp();
    const request = () => app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        regionSlug: 'region_fsn1',
        runtimeSlot: 'studio',
      }),
    });

    const ambiguous = await request();
    const recovered = await request();

    expect(ambiguous.status).toBe(503);
    expect(recovered.status).toBe(200);
    expect(idempotencyKeys).toHaveLength(2);
    expect(new Set(idempotencyKeys).size).toBe(1);
    await expect(getLatestCheckoutAttempt(db, 'user_123')).resolves.toMatchObject({
      id: idempotencyKeys[0],
      runtimeSlot: 'studio',
      stripeSessionId: 'cs_recovered',
      status: 'open',
    });
  });

  it('does not replace a payable open Checkout with a different selection', async () => {
    const app = createApp();
    const first = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        regionSlug: 'region_fsn1',
        runtimeSlot: 'studio',
      }),
    });
    const replacement = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_max',
        interval: 'annual',
        regionSlug: 'region_nbg1',
        runtimeSlot: 'studio',
      }),
    });

    expect(first.status).toBe(200);
    expect(replacement.status).toBe(409);
    await expect(replacement.json()).resolves.toEqual({
      error: 'Checkout selection conflicts with an open session',
      code: 'checkout_selection_conflict',
      selection: {
        planSlug: 'matrix_builder',
        interval: 'monthly',
        regionSlug: 'region_fsn1',
      },
    });
    expect(stripe.createCheckoutSession).toHaveBeenCalledOnce();
  });

  it('retires an expired legacy checkout with missing selection before claiming a replacement', async () => {
    await insertCheckoutAttempt(db, {
      id: 'attempt_legacy_studio',
      clerkUserId: 'user_123',
      stripeSessionId: 'cs_legacy_studio',
      runtimeSlot: 'studio',
      createdAt: '2026-05-28T00:00:00.000Z',
      status: 'open',
    });
    const app = createApp();

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        regionSlug: 'region_fsn1',
        runtimeSlot: 'studio',
      }),
    });

    expect(res.status).toBe(200);
    expect(stripe.createCheckoutSession).toHaveBeenCalledOnce();
    await expect(
      db.executor
        .selectFrom('billing_checkout_attempts')
        .select(['status', 'resolved_at'])
        .where('id', '=', 'attempt_legacy_studio')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: 'abandoned',
      resolved_at: '2026-05-30T00:00:00.000Z',
    });
    await expect(getLatestCheckoutAttempt(db, 'user_123')).resolves.toMatchObject({
      runtimeSlot: 'studio',
      planSlug: 'matrix_builder',
      billingInterval: 'monthly',
      regionSlug: 'region_fsn1',
      status: 'open',
    });
  });

  it('recovers a younger legacy checkout from its authoritative Stripe selection', async () => {
    await insertCheckoutAttempt(db, {
      id: 'attempt_recent_legacy_studio',
      clerkUserId: 'user_123',
      stripeSessionId: 'cs_recent_legacy_studio',
      runtimeSlot: 'studio',
      createdAt: '2026-05-29T23:00:00.000Z',
      status: 'open',
    });
    vi.mocked(stripe.retrieveCheckoutSession).mockResolvedValue({
      status: 'open',
      url: 'https://checkout.stripe.test/recovered-legacy',
      clerkUserId: 'user_123',
      priceId: 'price_builder_monthly',
      regionSlug: 'region_fsn1',
    });
    const app = createApp();

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        regionSlug: 'region_fsn1',
        runtimeSlot: 'studio',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      url: 'https://checkout.stripe.test/recovered-legacy',
    });
    expect(stripe.retrieveCheckoutSession).toHaveBeenCalledWith('cs_recent_legacy_studio');
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('returns the authoritative selection for a conflicting younger legacy checkout', async () => {
    await insertCheckoutAttempt(db, {
      id: 'attempt_conflicting_legacy_studio',
      clerkUserId: 'user_123',
      stripeSessionId: 'cs_conflicting_legacy_studio',
      runtimeSlot: 'studio',
      createdAt: '2026-05-29T23:00:00.000Z',
      status: 'open',
    });
    vi.mocked(stripe.retrieveCheckoutSession).mockResolvedValue({
      status: 'open',
      url: 'https://checkout.stripe.test/conflicting-legacy',
      clerkUserId: 'user_123',
      priceId: 'price_builder_monthly',
      regionSlug: 'region_fsn1',
    });
    const app = createApp();

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_max',
        interval: 'annual',
        regionSlug: 'region_nbg1',
        runtimeSlot: 'studio',
      }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'Checkout selection conflicts with an open session',
      code: 'checkout_selection_conflict',
      selection: {
        planSlug: 'matrix_builder',
        interval: 'monthly',
        regionSlug: 'region_fsn1',
      },
    });
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('replaces a younger legacy checkout after Stripe confirms it expired', async () => {
    await insertCheckoutAttempt(db, {
      id: 'attempt_expired_legacy_studio',
      clerkUserId: 'user_123',
      stripeSessionId: 'cs_expired_legacy_studio',
      runtimeSlot: 'studio',
      createdAt: '2026-05-29T23:00:00.000Z',
      status: 'open',
    });
    vi.mocked(stripe.retrieveCheckoutSession).mockResolvedValue({
      status: 'expired',
      url: null,
      clerkUserId: 'user_123',
      priceId: 'price_builder_monthly',
      regionSlug: 'region_fsn1',
    });
    const app = createApp();

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_max',
        interval: 'annual',
        regionSlug: 'region_nbg1',
        runtimeSlot: 'studio',
      }),
    });

    expect(res.status).toBe(200);
    expect(stripe.createCheckoutSession).toHaveBeenCalledOnce();
    await expect(
      db.executor
        .selectFrom('billing_checkout_attempts')
        .select(['status', 'resolved_at'])
        .where('id', '=', 'attempt_expired_legacy_studio')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: 'expired',
      resolved_at: '2026-05-30T00:00:00.000Z',
    });
  });

  it('does not create another subscription for an already entitled runtime slot', async () => {
    await upsertBillingSubscription(db, {
      stripeSubscriptionId: 'sub_studio',
      stripeCustomerId: 'cus_123',
      clerkUserId: 'user_123',
      runtimeSlot: 'studio',
      planSlug: 'matrix_builder',
      stripePriceId: 'price_builder_monthly',
      billingInterval: 'monthly',
      status: 'active',
      currentPeriodEnd: '2026-06-30T00:00:00.000Z',
      gracePeriodEndsAt: null,
      latestEventCreatedAt: '2026-05-29T00:00:00.000Z',
      latestEventId: 'evt_studio',
      updatedAt: '2026-05-29T00:00:01.000Z',
    });
    const app = createApp();

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_max',
        interval: 'annual',
        regionSlug: 'region_fsn1',
        runtimeSlot: 'studio',
      }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'Computer already has billing',
      code: 'runtime_already_subscribed',
    });
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('does not create another Checkout while a paid slot is awaiting its subscription webhook', async () => {
    await insertCheckoutAttempt(db, {
      id: 'attempt_paid_studio',
      clerkUserId: 'user_123',
      stripeSessionId: 'cs_paid_studio',
      runtimeSlot: 'studio',
      planSlug: 'matrix_builder',
      billingInterval: 'monthly',
      regionSlug: 'region_fsn1',
      createdAt: '2026-05-29T00:00:00.000Z',
      status: 'paid',
      resolvedAt: '2026-05-29T00:01:00.000Z',
    });
    const app = createApp();

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        regionSlug: 'region_fsn1',
        runtimeSlot: 'studio',
      }),
    });

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: 'Checkout is already starting',
      code: 'checkout_pending',
    });
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
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

  it('rejects unknown developer tool ids with a generic validation error', async () => {
    const app = createApp();

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        developerTools: ['codex', 'cursor'],
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid request' });
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('rejects oversized checkout bodies before parsing developer tool selections', async () => {
    const app = createApp();

    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        developerTools: ['codex'],
        padding: 'x'.repeat(20 * 1024),
      }),
    });

    expect(res.status).toBe(413);
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

  it('rejects the removed add-computer portal intent and unsafe return paths without calling Stripe', async () => {
    await upsertBillingCustomer(db, {
      clerkUserId: 'user_123', stripeCustomerId: 'cus_123',
      createdAt: '2026-05-30T00:00:00.000Z', updatedAt: '2026-05-30T00:00:00.000Z',
    });
    const app = createApp();

    const removedIntent = await app.request('/billing/portal', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'add_computer', returnPath: '/runtime?new=1' }),
    });
    const unsafe = await app.request('/billing/portal', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intent: 'manage', returnPath: 'https://evil.example' }),
    });

    expect(removedIntent.status).toBe(400);
    expect(unsafe.status).toBe(400);
    expect(stripe.createPortalSession).not.toHaveBeenCalled();
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
      maxRuntimeSlots: 1,
      defaultServerType: 'cpx52',
      allowedServerTypes: ['cpx22', 'cpx32', 'cpx52'],
    });
    await expect(getBillingSubscription(db, 'user_123', 'studio', '2026-05-30T00:00:00.000Z')).resolves.toMatchObject({
      stripeSubscriptionId: 'sub_123',
      runtimeSlot: 'studio',
      planSlug: 'matrix_max',
      status: 'active',
    });
  });

  it('authorizes the exact preparation only inside a signed active subscription projection', async () => {
    vi.mocked(stripe.constructWebhookEvent).mockReturnValue(subscriptionEvent('evt_prebilling', {
      runtimeSlot: 'primary',
      prebillingIntentId: 'intent_123',
    }));
    const authorizeSubscription = vi.fn().mockResolvedValue({
      authorized: true,
      machineId: 'machine_123',
      needsFallback: false,
    });
    const app = new Hono();
    app.route('/billing', createBillingRoutes({
      db,
      stripe,
      env,
      resolveClerkUserId: () => Promise.resolve(null),
      now: () => new Date('2026-05-30T00:00:00.000Z'),
      prebilling: {
        createIntent: vi.fn(),
        startPreparation: vi.fn(),
        authorizeSubscription,
        expireCheckout: vi.fn(),
      },
    }));

    const response = await app.request('/billing/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'valid' },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(authorizeSubscription).toHaveBeenCalledWith(expect.objectContaining({ executor: expect.anything() }), {
      intentId: 'intent_123',
      clerkUserId: 'user_123',
      runtimeSlot: 'primary',
      now: '2026-05-30T00:00:00.000Z',
    });
  });

  it('keeps subscriptions independent when one additional computer is canceled', async () => {
    vi.mocked(stripe.constructWebhookEvent)
      .mockReturnValueOnce(subscriptionEvent('evt_primary', {
        subscriptionId: 'sub_primary',
        runtimeSlot: 'primary',
        priceId: 'price_starter_monthly',
      }))
      .mockReturnValueOnce(subscriptionEvent('evt_studio', {
        subscriptionId: 'sub_studio',
        runtimeSlot: 'studio',
        priceId: 'price_max_monthly',
      }))
      .mockReturnValueOnce(subscriptionEvent('evt_studio_canceled', {
        subscriptionId: 'sub_studio',
        runtimeSlot: 'studio',
        priceId: 'price_max_monthly',
        status: 'canceled',
        created: 1_779_753_700,
        currentPeriodEnd: 1_700_000_000,
      }));
    const webhookApp = createApp(null);
    for (let index = 0; index < 3; index += 1) {
      const response = await webhookApp.request('/billing/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': 'valid' },
        body: '{}',
      });
      expect(response.status).toBe(200);
    }

    const statusApp = createApp();
    const primary = await statusApp.request('/billing/status?runtimeSlot=primary');
    const studio = await statusApp.request('/billing/status?runtimeSlot=studio');

    await expect(primary.json()).resolves.toMatchObject({
      entitlement: { stripeSubscriptionId: 'sub_primary', planSlug: 'matrix_starter', status: 'active' },
      access: { runtimeProxyAllowed: true },
    });
    await expect(studio.json()).resolves.toMatchObject({
      entitlement: { stripeSubscriptionId: 'sub_studio', planSlug: 'matrix_max', status: 'canceled' },
      access: { runtimeProxyAllowed: false },
    });
    await expect(getBillingSubscription(db, 'user_123', 'primary', '2026-05-30T00:00:00.000Z')).resolves.toMatchObject({ status: 'active' });
  });

  it('captures subscription revenue metrics from Stripe webhook projections', async () => {
    const captureEvent = vi.fn();
    vi.mocked(stripe.constructWebhookEvent).mockReturnValue(subscriptionEvent('evt_revenue'));
    const app = createApp(null, env, captureEvent);

    const res = await app.request('/billing/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'valid' },
      body: '{}',
    });

    expect(res.status).toBe(200);
    expect(captureEvent).toHaveBeenCalledWith(MATRIX_TELEMETRY_EVENTS.BILLING_SUBSCRIPTION_UPDATED, {
      distinctId: 'user_123',
      properties: {
        plan_slug: 'matrix_max',
        subscription_status: 'active',
        billing_interval: 'monthly',
        price_usd: 49,
        included_runtime_slots: 1,
        addon_runtime_slots: 0,
        max_runtime_slots: 1,
      },
    });
    expect(JSON.stringify(captureEvent.mock.calls)).not.toContain('sub_123');
    expect(JSON.stringify(captureEvent.mock.calls)).not.toContain('cus_123');
  });

  it('captures checkout completed and expired webhooks without Stripe session ids', async () => {
    const captureEvent = vi.fn();
    vi.mocked(stripe.constructWebhookEvent)
      .mockReturnValueOnce(checkoutSessionEvent('evt_checkout_paid', 'checkout.session.completed'))
      .mockReturnValueOnce(checkoutSessionEvent('evt_checkout_expired', 'checkout.session.expired'));
    const app = createApp(null, env, captureEvent);

    const completed = await app.request('/billing/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'valid' },
      body: '{}',
    });
    const expired = await app.request('/billing/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'valid' },
      body: '{}',
    });

    expect(completed.status).toBe(200);
    expect(expired.status).toBe(200);
    expect(captureEvent).toHaveBeenCalledWith(MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_COMPLETED, {
      distinctId: 'user_123',
      properties: { stripe_event_type: 'checkout.session.completed' },
    });
    expect(captureEvent).toHaveBeenCalledWith(MATRIX_TELEMETRY_EVENTS.BILLING_CHECKOUT_EXPIRED, {
      distinctId: 'user_123',
      properties: { stripe_event_type: 'checkout.session.expired' },
    });
    expect(JSON.stringify(captureEvent.mock.calls)).not.toContain('cs_growth_test');
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

  it('projects Stripe trial dates and gates the first failed conversion while scheduling one suspension', async () => {
    await insertUserMachine(db, {
      machineId: 'machine_trial',
      clerkUserId: 'user_123',
      handle: 'trial-user',
      runtimeSlot: 'primary',
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      status: 'running',
      imageVersion: 'v1',
      provisionedAt: '2026-05-20T00:00:00.000Z',
    });
    vi.mocked(stripe.constructWebhookEvent)
      .mockReturnValueOnce(subscriptionEvent('evt_trial_started', {
        subscriptionId: 'sub_trial',
        runtimeSlot: 'primary',
        priceId: 'price_builder_monthly',
        status: 'trialing',
        trialStart: Date.parse('2026-05-23T00:00:00.000Z') / 1000,
        trialEnd: Date.parse('2026-05-30T00:00:00.000Z') / 1000,
      }))
      .mockReturnValueOnce(invoiceEvent('evt_trial_failed', 'invoice.payment_failed', 'sub_trial'));
    const app = createApp(null);

    for (let index = 0; index < 2; index += 1) {
      const response = await app.request('/billing/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': 'valid' },
        body: '{}',
      });
      expect(response.status).toBe(200);
    }

    await expect(getBillingSubscription(db, 'user_123', 'primary', '2026-05-30T00:00:00.000Z')).resolves.toMatchObject({
      status: 'trialing',
      trialStartedAt: '2026-05-23T00:00:00.000Z',
      trialEndsAt: '2026-05-30T00:00:00.000Z',
      trialConvertedAt: null,
      firstTrialPaymentFailedAt: '2026-05-30T00:00:00.000Z',
      gracePeriodEndsAt: null,
    });
    await expect(listBillingRuntimeActions(db, 'sub_trial')).resolves.toEqual([
      expect.objectContaining({
        machineId: 'machine_trial',
        action: 'suspend',
        status: 'queued',
        executeAfter: '2026-05-31T00:00:00.000Z',
      }),
    ]);
    const statusApp = createApp('user_123');
    const status = await statusApp.request('/billing/status?runtimeSlot=primary');
    await expect(status.json()).resolves.toMatchObject({
      entitlement: {
        billingInterval: 'monthly',
        firstTrialPaymentFailedAt: '2026-05-30T00:00:00.000Z',
      },
      access: { runtimeProxyAllowed: false, reason: 'payment_required' },
      trialOffer: { eligible: false, durationDays: 7 },
    });
  });

  it('anchors delayed trial-failure suspension to the Stripe failure time', async () => {
    await insertUserMachine(db, {
      machineId: 'machine_trial', clerkUserId: 'user_123', handle: 'trial-user',
      runtimeSlot: 'primary', hetznerServerId: 123456, publicIPv4: '203.0.113.10',
      status: 'running', imageVersion: 'v1', provisionedAt: '2026-05-20T00:00:00.000Z',
    });
    vi.mocked(stripe.constructWebhookEvent)
      .mockReturnValueOnce(subscriptionEvent('evt_trial_started_delayed', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly',
        status: 'trialing',
        trialStart: Date.parse('2026-05-23T00:00:00.000Z') / 1000,
        trialEnd: Date.parse('2026-05-30T00:00:00.000Z') / 1000,
      }))
      .mockReturnValueOnce(invoiceEvent('evt_trial_failed_delayed', 'invoice.payment_failed', 'sub_trial'));
    const app = createApp(null, env, undefined, () => new Date('2026-06-02T00:00:00.000Z'));

    for (let index = 0; index < 2; index += 1) {
      const response = await app.request('/billing/webhooks/stripe', {
        method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
      });
      expect(response.status).toBe(200);
    }

    await expect(listBillingRuntimeActions(db, 'sub_trial')).resolves.toEqual([
      expect.objectContaining({ executeAfter: '2026-05-31T00:00:00.000Z' }),
    ]);
  });

  it('schedules an early-canceled trial suspension 24 hours after trial_end', async () => {
    await insertUserMachine(db, {
      machineId: 'machine_trial', clerkUserId: 'user_123', handle: 'trial-user',
      runtimeSlot: 'primary', hetznerServerId: 123456, publicIPv4: '203.0.113.10',
      status: 'running', imageVersion: 'v1', provisionedAt: '2026-05-20T00:00:00.000Z',
    });
    vi.mocked(stripe.constructWebhookEvent).mockReturnValue(subscriptionEvent('evt_trial_canceled', {
      subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'canceled',
      trialStart: Date.parse('2026-05-30T00:00:00.000Z') / 1000,
      trialEnd: Date.parse('2026-06-06T00:00:00.000Z') / 1000,
    }));
    const app = createApp(null);

    const response = await app.request('/billing/webhooks/stripe', {
      method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
    });

    expect(response.status).toBe(200);
    await expect(listBillingRuntimeActions(db, 'sub_trial')).resolves.toEqual([
      expect.objectContaining({
        action: 'suspend', status: 'queued', executeAfter: '2026-06-07T00:00:00.000Z',
      }),
    ]);
    const status = await createApp('user_123').request('/billing/status?runtimeSlot=primary');
    await expect(status.json()).resolves.toMatchObject({
      access: { runtimeProxyAllowed: true },
    });
  });

  it('cancels an early-cancellation suspension when Stripe restores the trial', async () => {
    await insertUserMachine(db, {
      machineId: 'machine_trial', clerkUserId: 'user_123', handle: 'trial-user',
      runtimeSlot: 'primary', hetznerServerId: 123456, publicIPv4: '203.0.113.10',
      status: 'running', imageVersion: 'v1', provisionedAt: '2026-05-20T00:00:00.000Z',
    });
    const trialStart = Date.parse('2026-05-30T00:00:00.000Z') / 1000;
    const trialEnd = Date.parse('2026-06-06T00:00:00.000Z') / 1000;
    vi.mocked(stripe.constructWebhookEvent)
      .mockReturnValueOnce(subscriptionEvent('evt_trial_canceled', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'canceled',
        trialStart, trialEnd,
      }))
      .mockReturnValueOnce(subscriptionEvent('evt_trial_restored', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'trialing',
        created: Date.parse('2026-05-30T00:01:00.000Z') / 1000,
        trialStart, trialEnd,
      }));
    const app = createApp(null);

    for (let index = 0; index < 2; index += 1) {
      const response = await app.request('/billing/webhooks/stripe', {
        method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
      });
      expect(response.status).toBe(200);
    }

    await expect(listBillingRuntimeActions(db, 'sub_trial')).resolves.toEqual([
      expect.objectContaining({ action: 'suspend', status: 'canceled' }),
    ]);
    const status = await createApp('user_123').request('/billing/status?runtimeSlot=primary');
    await expect(status.json()).resolves.toMatchObject({
      access: { runtimeProxyAllowed: true },
    });
  });

  it('requests cancellation and queues recovery when Stripe restores a trial during suspension', async () => {
    await insertUserMachine(db, {
      machineId: 'machine_trial', clerkUserId: 'user_123', handle: 'trial-user',
      runtimeSlot: 'primary', hetznerServerId: 123456, publicIPv4: '203.0.113.10',
      status: 'suspending', imageVersion: 'v1', provisionedAt: '2026-05-20T00:00:00.000Z',
    });
    const trialStart = Date.parse('2026-05-30T00:00:00.000Z') / 1000;
    const trialEnd = Date.parse('2026-06-06T00:00:00.000Z') / 1000;
    vi.mocked(stripe.constructWebhookEvent)
      .mockReturnValueOnce(subscriptionEvent('evt_trial_canceled_running', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'canceled',
        created: Date.parse('2026-06-06T00:00:00.000Z') / 1000,
        trialStart, trialEnd,
      }))
      .mockReturnValueOnce(subscriptionEvent('evt_trial_restored_running', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'trialing',
        created: Date.parse('2026-06-07T00:02:00.000Z') / 1000,
        trialStart, trialEnd,
      }));
    const app = createApp(null, env, undefined, () => new Date('2026-06-07T00:03:00.000Z'));
    await app.request('/billing/webhooks/stripe', {
      method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
    });
    const suspend = (await listBillingRuntimeActions(db, 'sub_trial'))
      .find((action) => action.action === 'suspend');
    expect(suspend).toBeDefined();
    await claimBillingRuntimeAction(
      db,
      suspend!.id,
      '2026-06-07T00:00:00.000Z',
      '2026-06-07T00:05:00.000Z',
      5,
    );

    const restored = await app.request('/billing/webhooks/stripe', {
      method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
    });

    expect(restored.status).toBe(200);
    await expect(listBillingRuntimeActions(db, 'sub_trial')).resolves.toEqual([
      expect.objectContaining({
        action: 'suspend', status: 'running', cancelRequestedAt: '2026-06-07T00:03:00.000Z',
      }),
      expect.objectContaining({ action: 'resume', status: 'queued', reason: 'billing_recovered' }),
    ]);
  });

  it('does not schedule a suspension from an out-of-order canceled subscription event', async () => {
    await insertUserMachine(db, {
      machineId: 'machine_trial', clerkUserId: 'user_123', handle: 'trial-user',
      runtimeSlot: 'primary', hetznerServerId: 123456, publicIPv4: '203.0.113.10',
      status: 'running', imageVersion: 'v1', provisionedAt: '2026-05-20T00:00:00.000Z',
    });
    const trialStart = Date.parse('2026-05-30T00:00:00.000Z') / 1000;
    const trialEnd = Date.parse('2026-06-06T00:00:00.000Z') / 1000;
    vi.mocked(stripe.constructWebhookEvent)
      .mockReturnValueOnce(subscriptionEvent('evt_trial_current', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'trialing',
        created: Date.parse('2026-05-30T00:02:00.000Z') / 1000,
        trialStart, trialEnd,
      }))
      .mockReturnValueOnce(subscriptionEvent('evt_trial_stale_cancel', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'canceled',
        created: Date.parse('2026-05-30T00:01:00.000Z') / 1000,
        trialStart, trialEnd,
      }));
    const app = createApp(null);

    for (let index = 0; index < 2; index += 1) {
      const response = await app.request('/billing/webhooks/stripe', {
        method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
      });
      expect(response.status).toBe(200);
    }

    await expect(listBillingRuntimeActions(db, 'sub_trial')).resolves.toEqual([]);
    await expect(getBillingSubscription(db, 'user_123', 'primary', '2026-05-30T00:02:00.000Z')).resolves
      .toMatchObject({ status: 'trialing', latestEventId: 'evt_trial_current' });
  });

  it('does not let an out-of-order paid invoice reverse a newer failed conversion', async () => {
    await insertUserMachine(db, {
      machineId: 'machine_trial', clerkUserId: 'user_123', handle: 'trial-user',
      runtimeSlot: 'primary', hetznerServerId: 123456, publicIPv4: '203.0.113.10',
      status: 'running', imageVersion: 'v1', provisionedAt: '2026-05-20T00:00:00.000Z',
    });
    vi.mocked(stripe.constructWebhookEvent)
      .mockReturnValueOnce(subscriptionEvent('evt_trial_started', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'trialing',
        trialStart: Date.parse('2026-05-23T00:00:00.000Z') / 1000,
        trialEnd: Date.parse('2026-05-30T00:00:00.000Z') / 1000,
      }))
      .mockReturnValueOnce({
        ...invoiceEvent('evt_trial_failed_current', 'invoice.payment_failed', 'sub_trial'),
        created: Date.parse('2026-05-30T00:02:00.000Z') / 1000,
      })
      .mockReturnValueOnce({
        ...invoiceEvent('evt_trial_paid_stale', 'invoice.paid', 'sub_trial'),
        created: Date.parse('2026-05-30T00:01:00.000Z') / 1000,
      });
    const app = createApp(null);

    for (let index = 0; index < 3; index += 1) {
      const response = await app.request('/billing/webhooks/stripe', {
        method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
      });
      expect(response.status).toBe(200);
    }

    await expect(getBillingSubscription(db, 'user_123', 'primary', '2026-05-30T00:03:00.000Z')).resolves
      .toMatchObject({
        trialConvertedAt: null,
        firstTrialPaymentFailedAt: '2026-05-30T00:02:00.000Z',
        latestEventId: 'evt_trial_started',
      });
    await expect(listBillingRuntimeActions(db, 'sub_trial')).resolves.toEqual([
      expect.objectContaining({ action: 'suspend', status: 'queued' }),
    ]);
  });

  it('keeps three-day renewal grace when Stripe reports periods on subscription items', async () => {
    const trialStart = Date.parse('2026-05-23T00:00:00.000Z') / 1000;
    const trialEnd = Date.parse('2026-05-30T00:00:00.000Z') / 1000;
    const renewalStart = Date.parse('2026-06-30T00:00:00.000Z') / 1000;
    const renewalEnd = Date.parse('2026-07-30T00:00:00.000Z') / 1000;
    vi.mocked(stripe.constructWebhookEvent)
      .mockReturnValueOnce(subscriptionEvent('evt_trial_started', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'trialing',
        created: trialStart, trialStart, trialEnd,
      }))
      .mockReturnValueOnce(invoiceEvent('evt_trial_converted', 'invoice.paid', 'sub_trial'))
      .mockReturnValueOnce(subscriptionEvent('evt_trial_active', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'active',
        created: trialEnd + 60, trialStart, trialEnd,
        omitTopLevelCurrentPeriodEnd: true,
        itemCurrentPeriodStart: trialEnd,
        itemCurrentPeriodEnd: renewalStart,
      }))
      .mockReturnValueOnce(subscriptionEvent('evt_renewal_past_due', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'past_due',
        created: renewalStart, trialStart, trialEnd,
        omitTopLevelCurrentPeriodEnd: true,
        itemCurrentPeriodStart: renewalStart,
        itemCurrentPeriodEnd: renewalEnd,
      }));
    const app = createApp('user_123', env, undefined, () => new Date('2026-07-01T00:00:00.000Z'));

    for (let index = 0; index < 4; index += 1) {
      const response = await app.request('/billing/webhooks/stripe', {
        method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
      });
      expect(response.status).toBe(200);
    }

    const status = await app.request('/billing/status?runtimeSlot=primary');
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({
      entitlement: {
        status: 'past_due',
        gracePeriodEndsAt: '2026-07-03T00:00:00.000Z',
      },
      access: {
        runtimeProxyAllowed: true,
        reason: 'grace_period',
      },
    });
  });

  it('does not let an older paid invoice convert a trial after a newer terminal subscription event', async () => {
    await insertUserMachine(db, {
      machineId: 'machine_trial', clerkUserId: 'user_123', handle: 'trial-user',
      runtimeSlot: 'primary', hetznerServerId: 123456, publicIPv4: '203.0.113.10',
      status: 'running', imageVersion: 'v1', provisionedAt: '2026-05-20T00:00:00.000Z',
    });
    const trialStart = Date.parse('2026-05-23T00:00:00.000Z') / 1000;
    const trialEnd = Date.parse('2026-05-30T00:00:00.000Z') / 1000;
    vi.mocked(stripe.constructWebhookEvent)
      .mockReturnValueOnce(subscriptionEvent('evt_trial_started', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'trialing',
        created: Date.parse('2026-05-23T00:00:00.000Z') / 1000,
        trialStart, trialEnd,
      }))
      .mockReturnValueOnce(subscriptionEvent('evt_trial_canceled_current', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'canceled',
        created: Date.parse('2026-05-30T00:03:00.000Z') / 1000,
        trialStart, trialEnd,
      }))
      .mockReturnValueOnce({
        ...invoiceEvent('evt_trial_paid_stale_terminal', 'invoice.paid', 'sub_trial'),
        created: Date.parse('2026-05-30T00:02:00.000Z') / 1000,
      });
    const app = createApp(null);

    for (let index = 0; index < 3; index += 1) {
      const response = await app.request('/billing/webhooks/stripe', {
        method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
      });
      expect(response.status).toBe(200);
    }

    await expect(getBillingSubscription(db, 'user_123', 'primary', '2026-05-30T00:04:00.000Z')).resolves
      .toMatchObject({
        status: 'canceled',
        trialConvertedAt: null,
        latestEventId: 'evt_trial_canceled_current',
      });
    await expect(listBillingRuntimeActions(db, 'sub_trial')).resolves.toEqual([
      expect.objectContaining({ action: 'suspend', status: 'queued' }),
    ]);
  });

  it('cancels a pending suspension when the first post-trial invoice is paid', async () => {
    await insertUserMachine(db, {
      machineId: 'machine_trial',
      clerkUserId: 'user_123',
      handle: 'trial-user',
      runtimeSlot: 'primary',
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      status: 'running',
      imageVersion: 'v1',
      provisionedAt: '2026-05-20T00:00:00.000Z',
    });
    vi.mocked(stripe.constructWebhookEvent)
      .mockReturnValueOnce(subscriptionEvent('evt_trial_started', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'trialing',
        trialStart: Date.parse('2026-05-23T00:00:00.000Z') / 1000,
        trialEnd: Date.parse('2026-05-30T00:00:00.000Z') / 1000,
      }))
      .mockReturnValueOnce(invoiceEvent('evt_trial_failed', 'invoice.payment_failed', 'sub_trial'))
      .mockReturnValueOnce(invoiceEvent('evt_trial_paid', 'invoice.paid', 'sub_trial'));
    const app = createApp(null);

    for (let index = 0; index < 3; index += 1) {
      const response = await app.request('/billing/webhooks/stripe', {
        method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
      });
      expect(response.status).toBe(200);
    }

    await expect(getBillingSubscription(db, 'user_123', 'primary', '2026-05-30T00:00:00.000Z')).resolves.toMatchObject({
      trialConvertedAt: '2026-05-30T00:00:00.000Z',
      firstTrialPaymentFailedAt: null,
    });
    await expect(listBillingRuntimeActions(db, 'sub_trial')).resolves.toEqual([
      expect.objectContaining({ action: 'suspend', status: 'canceled' }),
    ]);
  });

  it('preserves the first failed-conversion timestamp across distinct retry events', async () => {
    await insertUserMachine(db, {
      machineId: 'machine_trial', clerkUserId: 'user_123', handle: 'trial-user',
      runtimeSlot: 'primary', hetznerServerId: 123456, publicIPv4: '203.0.113.10',
      status: 'running', imageVersion: 'v1', provisionedAt: '2026-05-20T00:00:00.000Z',
    });
    vi.mocked(stripe.constructWebhookEvent)
      .mockReturnValueOnce(subscriptionEvent('evt_trial_started', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'trialing',
        trialStart: Date.parse('2026-05-23T00:00:00.000Z') / 1000,
        trialEnd: Date.parse('2026-05-30T00:00:00.000Z') / 1000,
      }))
      .mockReturnValueOnce(invoiceEvent('evt_trial_failed_first', 'invoice.payment_failed', 'sub_trial'))
      .mockReturnValueOnce({
        ...invoiceEvent('evt_trial_failed_retry', 'invoice.payment_failed', 'sub_trial'),
        created: Date.parse('2026-05-30T01:00:00.000Z') / 1000,
      });
    const app = createApp(null);

    for (let index = 0; index < 3; index += 1) {
      const response = await app.request('/billing/webhooks/stripe', {
        method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
      });
      expect(response.status).toBe(200);
    }

    await expect(getBillingSubscription(db, 'user_123', 'primary', '2026-05-30T01:00:00.000Z')).resolves.toMatchObject({
      firstTrialPaymentFailedAt: '2026-05-30T00:00:00.000Z',
    });
    await expect(listBillingRuntimeActions(db, 'sub_trial')).resolves.toHaveLength(1);
  });

  it('requests cancellation and queues a resume when payment recovers after suspension has started', async () => {
    await insertUserMachine(db, {
      machineId: 'machine_trial',
      clerkUserId: 'user_123',
      handle: 'trial-user',
      runtimeSlot: 'primary',
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      status: 'suspending',
      imageVersion: 'v1',
      provisionedAt: '2026-05-20T00:00:00.000Z',
    });
    vi.mocked(stripe.constructWebhookEvent)
      .mockReturnValueOnce(subscriptionEvent('evt_trial_started', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'trialing',
        trialStart: Date.parse('2026-05-23T00:00:00.000Z') / 1000,
        trialEnd: Date.parse('2026-05-30T00:00:00.000Z') / 1000,
      }))
      .mockReturnValueOnce(invoiceEvent('evt_trial_failed', 'invoice.payment_failed', 'sub_trial'))
      .mockReturnValueOnce(invoiceEvent('evt_trial_paid', 'invoice.paid', 'sub_trial'));
    const app = createApp(null);

    for (let index = 0; index < 2; index += 1) {
      await app.request('/billing/webhooks/stripe', {
        method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
      });
    }
    const suspend = (await listBillingRuntimeActions(db, 'sub_trial'))
      .find((action) => action.action === 'suspend');
    expect(suspend).toBeDefined();
    await claimBillingRuntimeAction(
      db,
      suspend!.id,
      '2026-05-31T00:00:00.000Z',
      '2026-05-31T00:05:00.000Z',
      5,
    );

    const paid = await app.request('/billing/webhooks/stripe', {
      method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
    });

    expect(paid.status).toBe(200);
    await expect(listBillingRuntimeActions(db, 'sub_trial')).resolves.toEqual([
      expect.objectContaining({ action: 'resume', status: 'canceled', reason: 'billing_recovered' }),
      expect.objectContaining({
        action: 'suspend',
        status: 'running',
        cancelRequestedAt: '2026-05-30T00:00:00.000Z',
      }),
      expect.objectContaining({ action: 'resume', status: 'queued', reason: 'payment_recovered' }),
    ]);
  });

  it('queues a resume when payment recovers after suspension completed', async () => {
    await insertUserMachine(db, {
      machineId: 'machine_trial', clerkUserId: 'user_123', handle: 'trial-user',
      runtimeSlot: 'primary', hetznerServerId: 123456, publicIPv4: '203.0.113.10',
      status: 'suspended', imageVersion: 'v1', provisionedAt: '2026-05-20T00:00:00.000Z',
    });
    vi.mocked(stripe.constructWebhookEvent)
      .mockReturnValueOnce(subscriptionEvent('evt_trial_started_completed', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'trialing',
        trialStart: Date.parse('2026-05-23T00:00:00.000Z') / 1000,
        trialEnd: Date.parse('2026-05-30T00:00:00.000Z') / 1000,
      }))
      .mockReturnValueOnce(invoiceEvent('evt_trial_failed_completed', 'invoice.payment_failed', 'sub_trial'))
      .mockReturnValueOnce({
        ...invoiceEvent('evt_trial_paid_completed', 'invoice.paid', 'sub_trial'),
        created: Date.parse('2026-05-30T00:01:00.000Z') / 1000,
      });
    const app = createApp(null);
    for (let index = 0; index < 2; index += 1) {
      await app.request('/billing/webhooks/stripe', {
        method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
      });
    }
    const suspend = (await listBillingRuntimeActions(db, 'sub_trial'))
      .find((action) => action.action === 'suspend');
    expect(suspend).toBeDefined();
    await claimBillingRuntimeAction(
      db,
      suspend!.id,
      '2026-05-31T00:00:00.000Z',
      '2026-05-31T00:05:00.000Z',
      5,
    );
    await completeBillingRuntimeAction(db, suspend!.id, '2026-05-31T00:01:00.000Z');

    const paid = await app.request('/billing/webhooks/stripe', {
      method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
    });

    expect(paid.status).toBe(200);
    await expect(listBillingRuntimeActions(db, 'sub_trial')).resolves.toEqual([
      expect.objectContaining({ action: 'resume', status: 'canceled', reason: 'billing_recovered' }),
      expect.objectContaining({ action: 'suspend', status: 'completed' }),
      expect.objectContaining({ action: 'resume', status: 'queued', reason: 'payment_recovered' }),
    ]);
  });

  it('cancels a queued recovery resume when a newer failed conversion requires suspension', async () => {
    await insertUserMachine(db, {
      machineId: 'machine_trial', clerkUserId: 'user_123', handle: 'trial-user',
      runtimeSlot: 'primary', hetznerServerId: 123456, publicIPv4: '203.0.113.10',
      status: 'suspended', imageVersion: 'v1', provisionedAt: '2026-05-20T00:00:00.000Z',
    });
    vi.mocked(stripe.constructWebhookEvent)
      .mockReturnValueOnce(subscriptionEvent('evt_trial_started', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'trialing',
        trialStart: Date.parse('2026-05-23T00:00:00.000Z') / 1000,
        trialEnd: Date.parse('2026-05-30T00:00:00.000Z') / 1000,
      }))
      .mockReturnValueOnce({
        ...invoiceEvent('evt_trial_failed_newer', 'invoice.payment_failed', 'sub_trial'),
        created: Date.parse('2026-05-30T00:02:00.000Z') / 1000,
      });
    const app = createApp(null);
    await app.request('/billing/webhooks/stripe', {
      method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
    });
    await enqueueBillingRuntimeAction(db, {
      clerkUserId: 'user_123', runtimeSlot: 'primary', stripeSubscriptionId: 'sub_trial',
      action: 'resume', reason: 'payment_recovered', executeAfter: '2026-05-30T00:01:00.000Z',
      createdAt: '2026-05-30T00:01:00.000Z',
    });

    const failed = await app.request('/billing/webhooks/stripe', {
      method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
    });

    expect(failed.status).toBe(200);
    const actions = await listBillingRuntimeActions(db, 'sub_trial');
    expect(actions).toHaveLength(2);
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'resume', status: 'canceled' }),
      expect.objectContaining({ action: 'suspend', status: 'queued' }),
    ]));
  });

  it('revokes an in-flight recovery resume and makes its compensating suspension immediately due', async () => {
    await insertUserMachine(db, {
      machineId: 'machine_trial', clerkUserId: 'user_123', handle: 'trial-user',
      runtimeSlot: 'primary', hetznerServerId: 123456, publicIPv4: '203.0.113.10',
      status: 'resuming', imageVersion: 'v1', provisionedAt: '2026-05-20T00:00:00.000Z',
    });
    vi.mocked(stripe.constructWebhookEvent)
      .mockReturnValueOnce(subscriptionEvent('evt_trial_started', {
        subscriptionId: 'sub_trial', runtimeSlot: 'primary', priceId: 'price_builder_monthly', status: 'trialing',
        trialStart: Date.parse('2026-05-23T00:00:00.000Z') / 1000,
        trialEnd: Date.parse('2026-05-30T00:00:00.000Z') / 1000,
      }))
      .mockReturnValueOnce({
        ...invoiceEvent('evt_trial_failed_newer', 'invoice.payment_failed', 'sub_trial'),
        created: Date.parse('2026-05-30T00:02:00.000Z') / 1000,
      });
    const app = createApp(
      null,
      env,
      undefined,
      () => new Date('2026-05-30T00:03:00.000Z'),
    );
    await app.request('/billing/webhooks/stripe', {
      method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
    });
    const resume = await enqueueBillingRuntimeAction(db, {
      clerkUserId: 'user_123', runtimeSlot: 'primary', stripeSubscriptionId: 'sub_trial',
      action: 'resume', reason: 'payment_recovered', executeAfter: '2026-05-30T00:01:00.000Z',
      createdAt: '2026-05-30T00:01:00.000Z',
    });
    expect(resume).toBeDefined();
    await claimBillingRuntimeAction(
      db,
      resume!.id,
      '2026-05-30T00:01:00.000Z',
      '2026-05-30T00:06:00.000Z',
      5,
    );

    const failed = await app.request('/billing/webhooks/stripe', {
      method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}',
    });

    expect(failed.status).toBe(200);
    const actions = await listBillingRuntimeActions(db, 'sub_trial');
    expect(actions).toHaveLength(2);
    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'resume',
        status: 'running',
        cancelRequestedAt: '2026-05-30T00:03:00.000Z',
      }),
      expect.objectContaining({
        action: 'suspend', status: 'queued', executeAfter: '2026-05-30T00:03:00.000Z',
      }),
    ]));
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
      maxRuntimeSlots: 1,
    });
  });

  it('captures matrix_billing_webhook_failed when the Stripe signature is invalid', async () => {
    vi.mocked(stripe.constructWebhookEvent).mockImplementation(() => {
      throw new Error('bad signature: sk_live_secret');
    });
    const captureEvent = vi.fn();
    const app = new Hono();
    app.route('/billing', createBillingRoutes({
      db,
      stripe,
      env,
      resolveClerkUserId: () => Promise.resolve(null),
      now: () => new Date('2026-05-30T00:00:00.000Z'),
      captureEvent,
    }));

    const res = await app.request('/billing/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'invalid' },
      body: '{}',
    });

    expect(res.status).toBe(400);
    expect(captureEvent).toHaveBeenCalledTimes(1);
    expect(captureEvent).toHaveBeenCalledWith('matrix_billing_webhook_failed', {
      properties: { reason: 'invalid_signature' },
    });
    expect(JSON.stringify(captureEvent.mock.calls)).not.toContain('sk_live_secret');
  });

  it('captures matrix_billing_webhook_failed with the Stripe event type on processing errors', async () => {
    await upsertBillingCustomer(db, {
      clerkUserId: 'user_123',
      stripeCustomerId: 'cus_123',
      createdAt: '2026-05-30T00:00:00.000Z',
      updatedAt: '2026-05-30T00:00:00.000Z',
    });
    vi.mocked(stripe.constructWebhookEvent).mockReturnValue(subscriptionEvent('evt_capture_fail'));
    const captureEvent = vi.fn();
    const app = new Hono();
    app.route('/billing', createBillingRoutes({
      db,
      stripe,
      env,
      resolveClerkUserId: () => Promise.resolve(null),
      now: () => new Date('2026-05-30T00:00:00.000Z'),
      captureEvent,
      upsertEntitlement: async () => {
        throw new Error('entitlement write timeout');
      },
    }));

    const res = await app.request('/billing/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 'valid' },
      body: '{}',
    });

    expect(res.status).toBe(500);
    expect(captureEvent).toHaveBeenCalledTimes(1);
    expect(captureEvent).toHaveBeenCalledWith('matrix_billing_webhook_failed', {
      properties: { reason: 'processing_error', event_type: 'customer.subscription.updated' },
    });
    expect(JSON.stringify(captureEvent.mock.calls)).not.toContain('entitlement write timeout');
  });

  it('never lets a throwing captureEvent change the webhook response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.mocked(stripe.constructWebhookEvent).mockImplementation(() => {
        throw new Error('bad signature');
      });
      const app = new Hono();
      app.route('/billing', createBillingRoutes({
        db,
        stripe,
        env,
        resolveClerkUserId: () => Promise.resolve(null),
        now: () => new Date('2026-05-30T00:00:00.000Z'),
        captureEvent: () => {
          throw new Error('posthog down');
        },
      }));

      const res = await app.request('/billing/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': 'invalid' },
        body: '{}',
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid webhook' });
    } finally {
      warn.mockRestore();
    }
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

function subscriptionEvent(id: string, overrides: {
  subscriptionId?: string;
  runtimeSlot?: string;
  priceId?: string;
  status?: string;
  created?: number;
  currentPeriodEnd?: number;
  omitTopLevelCurrentPeriodEnd?: boolean;
  itemCurrentPeriodStart?: number;
  itemCurrentPeriodEnd?: number;
  trialStart?: number;
  trialEnd?: number;
  prebillingIntentId?: string;
} = {}): StripeWebhookEvent {
  return {
    id,
    type: 'customer.subscription.updated',
    created: overrides.created ?? 1_779_753_600,
    data: {
      object: {
        id: overrides.subscriptionId ?? 'sub_123',
        customer: 'cus_123',
        status: overrides.status ?? 'active',
        ...(!overrides.omitTopLevelCurrentPeriodEnd
          ? { current_period_end: overrides.currentPeriodEnd ?? 1_782_432_000 }
          : {}),
        trial_start: overrides.trialStart,
        trial_end: overrides.trialEnd,
        metadata: {
          clerk_user_id: 'user_123',
          matrix_region_slug: 'region_fsn1',
          matrix_runtime_slot: overrides.runtimeSlot ?? 'studio',
          ...(overrides.prebillingIntentId
            ? { matrix_prebilling_intent_id: overrides.prebillingIntentId }
            : {}),
        },
        items: {
          data: [
            {
              price: { id: overrides.priceId ?? 'price_max_monthly' },
              quantity: 1,
              current_period_start: overrides.itemCurrentPeriodStart,
              current_period_end: overrides.itemCurrentPeriodEnd,
            },
            { price: { id: 'price_extra_runtime_monthly' }, quantity: 1 },
          ],
        },
      },
    },
  };
}

function invoiceEvent(
  id: string,
  type: 'invoice.paid' | 'invoice.payment_failed',
  subscriptionId: string,
): StripeWebhookEvent {
  return {
    id,
    type,
    created: Date.parse('2026-05-30T00:00:00.000Z') / 1000,
    data: {
      object: {
        id: `in_${id}`,
        created: Date.parse('2026-05-30T00:00:00.000Z') / 1000,
        billing_reason: 'subscription_cycle',
        parent: { subscription_details: { subscription: subscriptionId } },
      },
    },
  };
}

function checkoutSessionEvent(
  id: string,
  type: 'checkout.session.completed' | 'checkout.session.expired',
): StripeWebhookEvent {
  return {
    id,
    type,
    created: 1_779_753_600,
    data: {
      object: {
        id: 'cs_growth_test',
        client_reference_id: 'user_123',
        metadata: {
          clerk_user_id: 'user_123',
        },
      },
    },
  };
}
