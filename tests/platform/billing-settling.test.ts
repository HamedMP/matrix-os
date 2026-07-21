import { Hono } from 'hono';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  getLatestCheckoutAttempt,
  getSettlingCheckoutAttempt,
  insertCheckoutAttempt,
  resolveCheckoutAttempt,
  sweepStaleCheckoutAttempts,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import {
  createBillingRoutes,
  type StripeBillingClient,
  type StripeWebhookEvent,
} from '../../packages/platform/src/billing-routes.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const env = {
  STRIPE_PRICE_MATRIX_BUILDER_MONTHLY: 'price_builder_monthly',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
} as NodeJS.ProcessEnv;

describe('platform billing checkout-attempt settling (spec 092)', () => {
  let db: PlatformDB;
  let stripe: StripeBillingClient;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    stripe = {
      apiTimeoutMs: 10_000,
      createCheckoutSession: vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.test/s', id: 'cs_live_1' }),
      createPortalSession: vi.fn(),
      constructWebhookEvent: vi.fn(),
    };
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function createApp(now = '2026-06-11T12:00:00.000Z') {
    const app = new Hono();
    app.route('/billing', createBillingRoutes({
      db,
      stripe,
      env,
      resolveClerkUserId: () => Promise.resolve('user_123'),
      now: () => new Date(now),
    }));
    return app;
  }

  async function sendWebhook(app: Hono, event: StripeWebhookEvent) {
    vi.mocked(stripe.constructWebhookEvent).mockReturnValue(event);
    return app.request('/billing/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig' },
      body: JSON.stringify(event),
    });
  }

  it('records an open checkout attempt with the Stripe session id', async () => {
    const app = createApp();
    const res = await app.request('/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planSlug: 'matrix_builder',
        interval: 'monthly',
        developerTools: ['codex', 'pi'],
      }),
    });
    expect(res.status).toBe(200);
    const attempt = await getLatestCheckoutAttempt(db, 'user_123');
    expect(attempt?.stripeSessionId).toBe('cs_live_1');
    expect(attempt?.status).toBe('open');
    expect(attempt?.developerTools).toEqual(['codex', 'pi']);
  });

  it('marks the attempt paid on checkout.session.completed', async () => {
    await insertCheckoutAttempt(db, { id: 'a1', clerkUserId: 'user_123', stripeSessionId: 'cs_live_1', createdAt: '2026-06-11T11:55:00.000Z' });
    const app = createApp();
    const res = await sendWebhook(app, {
      id: 'evt_1', type: 'checkout.session.completed', created: 1_750_000_000, data: { object: { id: 'cs_live_1' } },
    });
    expect(res.status).toBe(200);
    const attempt = await getLatestCheckoutAttempt(db, 'user_123');
    expect(attempt?.status).toBe('paid');
    expect(attempt?.resolvedAt).not.toBeNull();
  });

  it('marks the attempt expired on checkout.session.expired', async () => {
    await insertCheckoutAttempt(db, { id: 'a1', clerkUserId: 'user_123', stripeSessionId: 'cs_live_1', createdAt: '2026-06-11T11:55:00.000Z' });
    const app = createApp();
    const res = await sendWebhook(app, {
      id: 'evt_2', type: 'checkout.session.expired', created: 1_750_000_000, data: { object: { id: 'cs_live_1' } },
    });
    expect(res.status).toBe(200);
    expect((await getLatestCheckoutAttempt(db, 'user_123'))?.status).toBe('expired');
  });

  it('does not rewrite a terminal attempt on a duplicate/late completed event', async () => {
    await insertCheckoutAttempt(db, { id: 'a1', clerkUserId: 'user_123', stripeSessionId: 'cs_live_1', createdAt: '2026-06-11T11:55:00.000Z' });
    const app = createApp();
    await sendWebhook(app, { id: 'evt_x', type: 'checkout.session.expired', created: 1_750_000_000, data: { object: { id: 'cs_live_1' } } });
    await sendWebhook(app, { id: 'evt_y', type: 'checkout.session.completed', created: 1_750_000_100, data: { object: { id: 'cs_live_1' } } });
    // First terminal status wins; the later completed event must not flip expired->paid.
    expect((await getLatestCheckoutAttempt(db, 'user_123'))?.status).toBe('expired');
  });

  it('settling checkout attempts prefer paid selections over newer open selections', async () => {
    await insertCheckoutAttempt(db, {
      id: 'paid-tools',
      clerkUserId: 'user_123',
      stripeSessionId: 'cs_paid_tools',
      status: 'paid',
      createdAt: '2026-06-11T11:55:00.000Z',
      developerTools: ['claude-code'],
    });
    await insertCheckoutAttempt(db, {
      id: 'open-tools',
      clerkUserId: 'user_123',
      stripeSessionId: 'cs_open_tools',
      status: 'open',
      createdAt: '2026-06-11T11:59:00.000Z',
      developerTools: ['opencode', 'pi'],
    });

    const attempt = await getSettlingCheckoutAttempt(db, 'user_123');

    expect(attempt?.stripeSessionId).toBe('cs_paid_tools');
    expect(attempt?.developerTools).toEqual(['claude-code']);
  });

  it('sweeps a stale open attempt to abandoned', async () => {
    await insertCheckoutAttempt(db, { id: 'a1', clerkUserId: 'user_123', stripeSessionId: 'cs_old', createdAt: '2026-04-01T00:00:00.000Z' });
    const swept = await sweepStaleCheckoutAttempts(db, '2026-05-12T00:00:00.000Z', '2026-06-11T12:00:00.000Z', 50);
    expect(swept).toBe(1);
    expect((await getLatestCheckoutAttempt(db, 'user_123'))?.status).toBe('abandoned');
  });

  it('sweeps an interrupted creating claim on the shorter cutoff', async () => {
    const { claimCheckoutAttempt } = await import('../../packages/platform/src/db.js');
    await claimCheckoutAttempt(db, {
      id: 'creating-1',
      clerkUserId: 'user_123',
      runtimeSlot: 'studio',
      planSlug: 'matrix_builder',
      billingInterval: 'monthly',
      regionSlug: 'region_fsn1',
      createdAt: '2026-06-11T11:00:00.000Z',
    });

    const swept = await sweepStaleCheckoutAttempts(
      db,
      '2026-05-12T00:00:00.000Z',
      '2026-06-11T12:00:00.000Z',
      50,
      '2026-06-11T11:45:00.000Z',
    );

    expect(swept).toBe(1);
    expect((await getLatestCheckoutAttempt(db, 'user_123'))?.status).toBe('abandoned');
  });

  it('does not sweep an attempt that resolved to paid (status guard)', async () => {
    // Simulate the race: the row is stale-and-open at SELECT time, but resolves
    // to paid before the UPDATE. The status='open' guard must skip it.
    await insertCheckoutAttempt(db, { id: 'a1', clerkUserId: 'user_123', stripeSessionId: 'cs_paid', createdAt: '2026-04-01T00:00:00.000Z' });
    await resolveCheckoutAttempt(db, 'cs_paid', 'paid', '2026-04-01T00:01:00.000Z');
    const swept = await sweepStaleCheckoutAttempts(db, '2026-05-12T00:00:00.000Z', '2026-06-11T12:00:00.000Z', 50);
    expect(swept).toBe(0);
    expect((await getLatestCheckoutAttempt(db, 'user_123'))?.status).toBe('paid');
  });
});
