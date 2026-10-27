import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBillingRoutes, type StripeBillingClient, type PrebillingCheckoutCoordinator } from '../../packages/platform/src/billing-routes.js';
import { claimCheckoutAttempt, getLatestCheckoutAttempt, getBillingEntitlement, insertCheckoutAttempt, resolveCheckoutAttempt, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

describe('checkout return reconciliation', () => {
  let db: PlatformDB;
  let stripe: StripeBillingClient;
  const now = () => new Date('2026-10-24T07:00:00.000Z');
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    stripe = {
      apiTimeoutMs: 10_000, createCheckoutSession: vi.fn().mockResolvedValue({
        id: 'cs_recovered', url: 'https://checkout.stripe.test/recovered',
      }), createAiCreditCheckoutSession: vi.fn(),
      createPortalSession: vi.fn(), constructWebhookEvent: vi.fn(), retrieveRecurringPrice: vi.fn(),
      retrieveCheckoutSession: vi.fn().mockResolvedValue({ status: 'open', clerkUserId: 'owner', url: null, priceId: null, regionSlug: null }),
    };
  });
  afterEach(async () => { vi.restoreAllMocks(); await destroyTestPlatformDb(db); });
  function app(user: string | null = 'owner', prebilling?: PrebillingCheckoutCoordinator) {
    return new Hono().route('/billing', createBillingRoutes({ db, stripe, env: {
      STRIPE_PRICE_MATRIX_BUILDER_MONTHLY: 'price_builder',
    }, now,
      resolveClerkUserId: async () => user, prebilling }));
  }
  function request(body: unknown = {}, user: string | null = 'owner', prebilling?: PrebillingCheckoutCoordinator) {
    return app(user, prebilling).request('/billing/checkout/reconcile', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  async function seed(runtimeSlot = 'primary') {
    await insertCheckoutAttempt(db, { id: 'attempt', clerkUserId: 'owner', stripeSessionId: 'cs_stored', runtimeSlot,
      createdAt: '2026-10-24T06:59:00.000Z' });
  }
  it('requires authentication before any provider call', async () => {
    expect((await request({}, null)).status).toBe(401);
    expect(stripe.retrieveCheckoutSession).not.toHaveBeenCalled();
  });
  it.each([{ sessionId: 'cs_forged' }, { runtimeSlot: '../other' }, { runtimeSlot: 'primary', checkout: 'success' }])(
    'rejects client checkout identity and invalid scope %j', async body => {
      expect((await request(body)).status).toBe(400);
      expect(stripe.retrieveCheckoutSession).not.toHaveBeenCalled();
    });
  it('enforces a body limit before parsing', async () => {
    expect((await request({ padding: 'x'.repeat(20_000) })).status).toBe(413);
  });
  it('rejects malformed JSON', async () => {
    const res = await app().request('/billing/checkout/reconcile', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: '{' });
    expect(res.status).toBe(400);
  });
  it('caps repeated checks per owner', async () => {
    await seed();
    const instance = app();
    for (let i = 0; i < 12; i++) {
      expect((await instance.request('/billing/checkout/reconcile', { method: 'POST', body: '{}' })).status).toBe(200);
    }
    expect((await instance.request('/billing/checkout/reconcile', { method: 'POST', body: '{}' })).status).toBe(429);
    expect(stripe.retrieveCheckoutSession).toHaveBeenCalledTimes(12);
  });
  it('routes a legacy ambiguous create to a support-safe journey without replaying it', async () => {
    await claimCheckoutAttempt(db, { id: 'creating', clerkUserId: 'owner', runtimeSlot: 'primary',
      planSlug: 'matrix_builder', billingInterval: 'monthly', regionSlug: 'region_fsn1', createdAt: now().toISOString() });
    const res = await request();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'unresolved' });
    expect(stripe.retrieveCheckoutSession).not.toHaveBeenCalled();
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });
  it('recovers an ambiguous create with the persisted request and the same idempotency key', async () => {
    await claimCheckoutAttempt(db, { id: 'creating', clerkUserId: 'owner', runtimeSlot: 'primary',
      planSlug: 'matrix_builder', billingInterval: 'monthly', regionSlug: 'region_fsn1',
      createdAt: now().toISOString(), developerTools: ['codex'], checkoutRequest: {
        planSlug: 'matrix_builder', interval: 'monthly', regionSlug: 'region_fsn1',
        developerTools: ['codex'], returnPath: '/?billing=setup&handoff=add-computer',
        attribution: { utm_source: 'saved-source', landing_path: '/pricing' },
        googleAnalytics: { clientId: 'saved.client', analyticsConsent: 'granted',
          adUserData: 'denied', adPersonalization: 'denied', expiresAt: 1 },
      } });

    const res = await request();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'open' });
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'creating', clerkUserId: 'owner', priceId: 'price_builder',
      runtimeSlot: 'primary', regionSlug: 'region_fsn1', attribution: {
        utm_source: 'saved-source', landing_path: '/pricing',
      }, googleAnalytics: expect.objectContaining({ clientId: 'saved.client', expiresAt: 1 }),
    }));
    expect(await getLatestCheckoutAttempt(db, 'owner')).toMatchObject({
      status: 'open', stripeSessionId: 'cs_recovered', checkoutUrl: 'https://checkout.stripe.test/recovered',
    });
  });
  it('never replays a creating attempt after the provider idempotency window', async () => {
    await claimCheckoutAttempt(db, { id: 'old-creating', clerkUserId: 'owner', runtimeSlot: 'primary',
      planSlug: 'matrix_builder', billingInterval: 'monthly', regionSlug: 'region_fsn1',
      createdAt: '2026-10-23T07:59:59.999Z', developerTools: ['codex'], checkoutRequest: {
        planSlug: 'matrix_builder', interval: 'monthly', regionSlug: 'region_fsn1', developerTools: ['codex'],
      } });
    const res = await request();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'unresolved' });
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });
  it('does not retrieve another owner or slot checkout', async () => {
    await seed('studio');
    expect((await request({}, 'other')).status).toBe(200);
    expect((await request()).status).toBe(200);
    expect(stripe.retrieveCheckoutSession).not.toHaveBeenCalled();
  });
  it('keeps unfinished checkout resumable and returns no session identifiers or URLs', async () => {
    await seed();
    const res = await request();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'open' });
    expect(stripe.retrieveCheckoutSession).toHaveBeenCalledExactlyOnceWith('cs_stored');
    expect((await getLatestCheckoutAttempt(db, 'owner'))?.status).toBe('open');
    expect(stripe.createCheckoutSession).not.toHaveBeenCalled();
  });
  it('confirms stored checkout completion without granting runtime entitlement', async () => {
    await seed('studio');
    vi.mocked(stripe.retrieveCheckoutSession).mockResolvedValue({ status: 'complete', clerkUserId: 'owner', url: null, priceId: null, regionSlug: null });
    expect((await request({ runtimeSlot: 'studio' })).status).toBe(200);
    expect(await getLatestCheckoutAttempt(db, 'owner')).toMatchObject({ status: 'paid', resolvedAt: now().toISOString() });
    expect(await getBillingEntitlement(db, 'owner')).toBeUndefined();
  });
  it('rejects mismatched provider ownership without modifying checkout', async () => {
    await seed();
    vi.mocked(stripe.retrieveCheckoutSession).mockResolvedValue({ status: 'complete', clerkUserId: 'other', url: null, priceId: null, regionSlug: null });
    const res = await request();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Billing unavailable', code: 'billing_unavailable' });
    expect((await getLatestCheckoutAttempt(db, 'owner'))?.status).toBe('open');
  });
  it('returns a generic retryable failure on provider errors', async () => {
    await seed();
    const failure = new Error('private provider detail');
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(stripe.retrieveCheckoutSession).mockRejectedValue(failure);
    const res = await request();
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('private provider detail');
    expect(log).toHaveBeenCalledWith('[billing] checkout reconciliation failed:', failure);
    expect((await getLatestCheckoutAttempt(db, 'owner'))?.status).toBe('open');
  });
  it('refuses a provider client whose timeout exceeds the budget', async () => {
    await seed(); stripe.apiTimeoutMs = 60_000;
    expect((await request()).status).toBe(503);
    expect(stripe.retrieveCheckoutSession).not.toHaveBeenCalled();
  });
  it('expires checkout and prebilling state in one transaction', async () => {
    await seed();
    vi.mocked(stripe.retrieveCheckoutSession).mockResolvedValue({ status: 'expired', clerkUserId: 'owner', url: null, priceId: null, regionSlug: null });
    const expireCheckout = vi.fn(async () => { throw new Error('cleanup failed'); });
    const prebilling = { expireCheckout } as unknown as PrebillingCheckoutCoordinator;
    expect((await request({}, 'owner', prebilling)).status).toBe(503);
    expect((await getLatestCheckoutAttempt(db, 'owner'))?.status).toBe('open');
    expireCheckout.mockResolvedValueOnce({ cleaned: true, intentId: null } as never);
    expect((await request({}, 'owner', prebilling)).status).toBe(200);
    expect((await getLatestCheckoutAttempt(db, 'owner'))?.status).toBe('expired');
  });
  it('never overwrites completion from a concurrent signed webhook with expiration', async () => {
    await seed();
    vi.mocked(stripe.retrieveCheckoutSession).mockImplementation(async () => {
      await resolveCheckoutAttempt(db, 'cs_stored', 'paid', now().toISOString());
      return { status: 'expired', clerkUserId: 'owner', url: null, priceId: null, regionSlug: null };
    });
    const expireCheckout = vi.fn();
    expect((await request({}, 'owner', { expireCheckout } as unknown as PrebillingCheckoutCoordinator)).status).toBe(200);
    expect((await getLatestCheckoutAttempt(db, 'owner'))?.status).toBe('paid');
    expect(expireCheckout).not.toHaveBeenCalled();
  });
});
