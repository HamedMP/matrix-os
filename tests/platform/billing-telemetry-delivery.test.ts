import { Hono } from 'hono';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createBillingRoutes, type StripeWebhookEvent } from '../../packages/platform/src/billing-routes.js';
import { getBillingWebhookEvent, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const env = { STRIPE_PRICE_MATRIX_BUILDER_MONTHLY: 'price_builder', STRIPE_WEBHOOK_SECRET: 'test' };
function subscription(id: string, status = 'active', created = 1_779_753_600): StripeWebhookEvent {
  return { id, type: 'customer.subscription.updated', created, data: { object: {
    id: 'sub_delivery', customer: 'cus_delivery', status, current_period_end: 1_782_432_000,
    metadata: { clerk_user_id: 'user_delivery', matrix_runtime_slot: 'primary' },
    items: { data: [{ price: { id: 'price_builder', unit_amount: 10000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } }, quantity: 1 }] },
  } } };
}
const post = (app: Hono) => app.request('/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': 'valid' }, body: '{}' });
describe('billing telemetry delivery', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  function appFor(events: StripeWebhookEvent[], captureEvent = vi.fn(), persist?: Parameters<typeof createBillingRoutes>[0]['upsertEntitlement']) {
    const constructWebhookEvent = vi.fn();
    for (const event of events) constructWebhookEvent.mockReturnValueOnce(event);
    return createBillingRoutes({ db, env, resolveClerkUserId: async () => null,
      now: () => new Date('2026-05-30T00:00:00Z'), captureEvent, upsertEntitlement: persist,
      stripe: { constructWebhookEvent, apiTimeoutMs: 10000, createCheckoutSession: vi.fn(), createPortalSession: vi.fn() },
    });
  }
  it('does not publish lifecycle events from a rolled-back transaction, then emits once on retry', async () => {
    const capture = vi.fn();
    const trial = subscription('evt_rollback', 'trialing');
    trial.type = 'customer.subscription.created';
    // Failure after the subscription notification was previously emitted.
    const originalTransaction = db.transaction.bind(db);
    let fail = true;
    vi.spyOn(db, 'transaction').mockImplementation(async (fn) => originalTransaction(async (trx) => {
      const result = await fn(trx);
      if (fail) { fail = false; throw new Error('commit failed'); }
      return result;
    }));
    const app = appFor([trial, trial, trial], capture);
    expect((await post(app)).status).toBe(500);
    expect(capture.mock.calls.filter(([name]) => name !== 'matrix_billing_webhook_failed')).toEqual([]);
    expect(await getBillingWebhookEvent(db, trial.id)).toBeUndefined();
    expect((await post(app)).status).toBe(200);
    expect((await post(app)).status).toBe(200);
    expect(capture.mock.calls.filter(([name]) => name === 'matrix_billing_subscription_updated')).toHaveLength(1);
    expect(capture.mock.calls.filter(([name]) => name === 'matrix_billing_trial_started')).toHaveLength(1);
  });
  it('distinguishes state transitions from unchanged subscription updates and preserves repeat webhook deduplication', async () => {
    const capture = vi.fn();
    const a = subscription('evt_a');
    const app = appFor([a, a, subscription('evt_b', 'active', a.created + 1), subscription('evt_c', 'past_due', a.created + 2), subscription('evt_stale', 'active', a.created - 1)], capture);
    for (let i = 0; i < 5; i++) expect((await post(app)).status).toBe(200);
    const calls = capture.mock.calls.filter(([name]) => name === 'matrix_billing_subscription_updated');
    expect(calls).toHaveLength(3);
    expect(calls.map(([, opts]) => opts.properties.subscription_status_changed)).toEqual([true, false, true]);
    expect(calls[2][1].properties.previous_subscription_status).toBe('active');
    const keys = calls.map(([, opts]) => opts.properties.delivery_key);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(calls)).not.toContain('sub_delivery');
    expect(JSON.stringify(calls)).not.toContain('evt_a');
  });
});
