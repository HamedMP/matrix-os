import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBillingRoutes, type StripeBillingClient } from '../../packages/platform/src/billing-routes.js';
import { claimCardTrialCheckoutAttempt, claimCheckoutAttempt, getLatestCheckoutAttempt, insertCheckoutAttempt, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const env = {
  MATRIX_CARD_TRIALS_ENABLED: 'true',
  STRIPE_PRICE_MATRIX_STARTER_MONTHLY: 'price_starter',
  STRIPE_PRICE_MATRIX_BUILDER_MONTHLY: 'price_builder',
  STRIPE_PRICE_MATRIX_MAX_MONTHLY: 'price_max',
};

describe('Starter-only trial checkout', () => {
  let db: PlatformDB;
  let stripe: StripeBillingClient;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    stripe = {
      apiTimeoutMs: 10_000,
      createCheckoutSession: vi.fn().mockResolvedValue({ id: 'cs_trial', url: 'https://checkout.stripe.test/trial' }),
      retrieveCheckoutSession: vi.fn(), retrieveRecurringPrice: vi.fn(),
      createPortalSession: vi.fn(), constructWebhookEvent: vi.fn(),
    };
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  function app(extraEnv: NodeJS.ProcessEnv = {}) {
    return new Hono().route('/billing', createBillingRoutes({
      db, stripe, env: { ...env, ...extraEnv }, resolveClerkUserId: async () => 'user_trial',
      now: () => new Date('2026-10-18T10:00:00.000Z'),
    }));
  }
  function checkout(application: Hono, planSlug: string, runtimeSlot = 'primary') {
    return application.request('/billing/checkout', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planSlug, runtimeSlot, regionSlug: 'region_fsn1' }),
    });
  }
  it('offers and persists fourteen days on Starter by default', async () => {
    const application = app();
    await expect((await application.request('/billing/status?trialOfferVersion=2')).json()).resolves.toMatchObject({
      trialOffer: { eligible: true, durationDays: 3, eligiblePlanSlugs: ['matrix_starter', 'matrix_builder', 'matrix_max'], durationDaysByPlan: { matrix_starter: 14, matrix_builder: 3, matrix_max: 3 } },
    });
    expect((await checkout(application, 'matrix_starter')).status).toBe(200);
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ trialPeriodDays: 14, paymentMethodMode: 'card_required' }));
    await expect(getLatestCheckoutAttempt(db, 'user_trial')).resolves.toMatchObject({ trialPeriodDays: 14 });
    await expect((await application.request('/billing/status?trialOfferVersion=2')).json()).resolves.toMatchObject({
      trialOffer: { eligible: true, durationDays: 14, eligiblePlanSlugs: ['matrix_starter'],
        durationDaysByPlan: { matrix_starter: 14 } },
      activeCheckout: { status: 'open', planSlug: 'matrix_starter', interval: 'monthly', regionSlug: 'region_fsn1' },
    });
  });
  it.each([{ duration: null, reserved: false }, { duration: 7, reserved: false }, { duration: 7, reserved: true }])(
    'uses the current policy for an expired legacy $duration-day checkout (reserved=$reserved)', async ({ duration, reserved }) => {
      await insertCheckoutAttempt(db, {
        id: 'expired_legacy', clerkUserId: 'user_trial', stripeSessionId: 'cs_expired',
        trialPeriodDays: duration, createdAt: '2026-10-17T09:59:59.000Z',
      });
      if (reserved) {
        await db.executor.insertInto('billing_trial_accounts').values({
          clerk_user_id: 'user_trial', trial_checkout_attempt_id: 'expired_legacy',
          consumed_at: null, updated_at: '2026-10-17T09:59:59.000Z',
        }).execute();
      }
      expect((await checkout(app(), 'matrix_starter')).status).toBe(200);
      expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
        trialPeriodDays: 14, paymentMethodMode: 'card_required',
      }));
      await expect(getLatestCheckoutAttempt(db, 'user_trial')).resolves.toMatchObject({ trialPeriodDays: 14 });
  });
  it('keeps the legacy status payload parseable by installed clients', async () => {
    const response = await app().request('/billing/status');
    const body = await response.json();
    expect(body.trialOffer).toEqual({ eligible: true, durationDays: 3 });
  });
  it('rejects unknown trial offer protocol versions', async () => {
    expect((await app().request('/billing/status?trialOfferVersion=3')).status).toBe(400);
  });
  it.each(['matrix_builder', 'matrix_max'])('keeps the three-day trial on %s', async (plan) => {
    expect((await checkout(app(), plan)).status).toBe(200);
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ trialPeriodDays: 3, paymentMethodMode: 'card_required' }));
  });
  it('supports a configured Starter duration without changing the other plans', async () => {
    expect((await checkout(app({ MATRIX_STARTER_TRIAL_DAYS: '21' }), 'matrix_starter')).status).toBe(200);
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ trialPeriodDays: 21 }));
  });
  it.each(['0', '31', 'bad', '1.5', ' 14 '])('rejects invalid Starter duration %s at startup', (value) => {
    expect(() => app({ MATRIX_STARTER_TRIAL_DAYS: value })).toThrow('MATRIX_STARTER_TRIAL_DAYS must be an integer from 1 to 30');
  });
  it('does not extend trials to additional Starter computers', async () => {
    expect((await checkout(app(), 'matrix_starter', 'studio')).status).toBe(200);
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ trialPeriodDays: null }));
  });
  it('honors an already reserved Builder trial after policy withdrawal', async () => {
    await claimCardTrialCheckoutAttempt(db, {
      id: 'attempt_legacy', clerkUserId: 'user_trial', runtimeSlot: 'primary',
      planSlug: 'matrix_builder', billingInterval: 'monthly', regionSlug: 'region_fsn1',
      serverType: 'cpx42', developerTools: ['codex', 'claude-code', 'opencode', 'pi'],
      createdAt: '2026-10-18T09:59:59.000Z',
    }, 3);
    const application = app({ MATRIX_CARD_TRIALS_ENABLED: 'false' });
    await expect((await application.request('/billing/status?trialOfferVersion=2')).json()).resolves.toMatchObject({
      trialOffer: { eligible: true, durationDays: 3, eligiblePlanSlugs: ['matrix_builder'] },
      activeCheckout: { status: 'creating', planSlug: 'matrix_builder', interval: 'monthly',
        regionSlug: 'region_fsn1', developerTools: ['codex', 'claude-code', 'opencode', 'pi'] },
    });
    expect((await checkout(application, 'matrix_builder')).status).toBe(200);
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ trialPeriodDays: 3 }));
  });
  it.each([null, 7])('preserves an active Checkout promise of %s days without a trial-ledger reservation', async (duration) => {
    await claimCheckoutAttempt(db, {
      id: 'attempt_unlinked', clerkUserId: 'user_trial', runtimeSlot: 'primary',
      planSlug: 'matrix_starter', billingInterval: 'monthly', regionSlug: 'region_fsn1',
      serverType: 'cpx22', developerTools: ['codex'], trialPeriodDays: duration,
      createdAt: '2026-10-18T09:59:59.000Z',
    });
    expect((await checkout(app(), 'matrix_starter')).status).toBe(200);
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ trialPeriodDays: duration }));
  });
});
