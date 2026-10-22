import { Hono } from 'hono';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createBillingRoutes, type StripeBillingClient, type StripeWebhookEvent } from '../../packages/platform/src/billing-routes.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { insertUserMachine, upsertBillingCustomer, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const identity = { ownerId: 'user_subscription', machineId: 'subscription_machine', runtimeSlot: 'primary' };
const anchor = '2026-01-31T10:00:00.000Z';
const end = '2027-01-31T10:00:00.000Z';
const epoch = (at: string) => Date.parse(at) / 1000;
const env = { MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED: 'true', STRIPE_WEBHOOK_SECRET: 'whsec_fixture',
  STRIPE_PRICE_MATRIX_STARTER_ANNUAL: 'price_starter', STRIPE_PRICE_MATRIX_BUILDER_ANNUAL: 'price_builder',
  STRIPE_PRICE_MATRIX_MAX_ANNUAL: 'price_max' };

describe('signed subscription billing to allowance ledger', () => {
  let db: PlatformDB, app: Hono, event: StripeWebhookEvent, clock: Date;
  let repo: ReturnType<typeof createAiFundedPolicyRepository>;
  let sequence: number;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb()); clock = new Date(anchor); sequence = 0;
    await upsertBillingCustomer(db, { clerkUserId: identity.ownerId, stripeCustomerId: 'cus_subscription', createdAt: anchor, updatedAt: anchor });
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: 'subscription-user',
      runtimeSlot: 'primary', status: 'running', activationState: 'authorized', provisioningClass: 'customer', imageVersion: 'fixture', provisionedAt: anchor });
    repo = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => clock, subscriptionCreditEnv: env });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: ['@cf/zai-org/glm-5.3-flash'] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, budgetMode: 'credit_backed',
      allowedModelIds: ['@cf/zai-org/glm-5.3-flash'], monthlyBudgetMicrousd: 0, expiresAt: null });
    const unavailable = vi.fn().mockRejectedValue(new Error('Unexpected external Stripe call'));
    const stripe: StripeBillingClient = { apiTimeoutMs: 1000, createCheckoutSession: unavailable,
      retrieveCheckoutSession: unavailable, createPortalSession: unavailable, constructWebhookEvent: vi.fn(() => event) };
    app = new Hono().route('/billing', createBillingRoutes({ db, stripe, env, fundedAiRepository: repo,
      now: () => clock, resolveClerkUserId: async () => identity.ownerId }));
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  async function deliver(type: string, object: unknown, createdAt = clock) {
    event = { id: `evt_subscription_${String(++sequence).padStart(4, '0')}`, type, created: Math.floor(createdAt.getTime() / 1000), data: { object } };
    return app.request('/billing/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': 'verified_by_fixture' }, body: '{}' });
  }
  const subscription = (price = 'price_starter') => ({ id: 'sub_subscription', customer: 'cus_subscription', status: 'active',
    billing_cycle_anchor: epoch(anchor), current_period_end: epoch(end), metadata: { clerk_user_id: identity.ownerId, matrix_runtime_slot: 'primary' },
    items: { data: [{ price: { id: price, unit_amount: 10000, currency: 'usd', recurring: { interval: 'year', interval_count: 1 } }, quantity: 1 }] } });
  const invoice = (id = 'in_subscription', price = 'price_starter') => ({ id, customer: 'cus_subscription', subscription: 'sub_subscription',
    status: 'paid', created: Math.floor(clock.getTime() / 1000), billing_reason: 'subscription_cycle', amount_due: 10000, amount_paid: 10000,
    currency: 'usd', lines: { has_more: false, data: [{ amount: 10000, type: 'subscription', subscription: 'sub_subscription',
      price: { id: price }, period: { start: epoch(anchor), end: epoch(end) } }] } });
  const grants = () => db.executor.selectFrom('ai_funded_credit_ledger').selectAll().where('kind', '=', 'promotional_grant').execute();

  it('requires paid coverage, then grants/upgrades exactly once across distinct webhook deliveries', async () => {
    expect((await deliver('customer.subscription.created', subscription())).status).toBe(200);
    expect(await grants()).toEqual([]);
    expect((await deliver('invoice.paid', invoice())).status).toBe(200);
    expect((await deliver('invoice.paid', invoice())).status).toBe(200);
    expect((await grants()).map(e => Number(e.amount_microusd))).toEqual([5_000_000]);
    clock = new Date('2026-02-01T10:00:00.000Z');
    expect((await deliver('customer.subscription.updated', subscription('price_builder'))).status).toBe(200);
    expect(await grants()).toHaveLength(1);
    expect((await deliver('invoice.paid', invoice('in_upgrade', 'price_builder'))).status).toBe(200);
    expect((await grants()).map(e => Number(e.amount_microusd))).toEqual([5_000_000, 5_000_000]);
  });
  it('uses credential/funding access to catch up only the eligible anniversary month; checkout stays read-only', async () => {
    await deliver('customer.subscription.created', subscription()); await deliver('invoice.paid', invoice());
    clock = new Date('2026-04-01T12:00:00.000Z');
    await repo.getCheckoutFundingSummary(identity, Date.now() + 5000, { projectExpiredCredit: true });
    expect(await grants()).toHaveLength(1);
    const issued = await repo.issueRuntimeCredential(identity);
    expect(issued.credential.tokenId).toBeTruthy();
    expect(await grants()).toHaveLength(2);
    expect(await repo.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 5_000_000 });
    expect((await grants())[1].expires_at).toBe('2026-04-30T10:00:00.000Z');
  });
  it('retries a paid invoice arriving before subscription projection instead of losing the entitlement', async () => {
    const early = await deliver('invoice.paid', invoice());
    expect(early.status).toBeGreaterThanOrEqual(500);
    await deliver('customer.subscription.created', subscription());
    expect((await deliver('invoice.paid', invoice())).status).toBe(200);
    expect(await grants()).toHaveLength(1);
  });
  it('does not treat a one-off invoice item as a paid subscription installment', async () => {
    await deliver('customer.subscription.created', subscription('price_max'));
    const bill = invoice('in_oneoff', 'price_max');
    bill.lines.data[0]!.type = 'invoiceitem';
    expect((await deliver('invoice.paid', bill)).status).toBe(200);
    expect(await grants()).toEqual([]);
  });
  it('refuses invoice coverage attributed to another subscription', async () => {
    await deliver('customer.subscription.created', subscription());
    const bill = invoice(); bill.lines.data[0]!.subscription = 'sub_other';
    expect((await deliver('invoice.paid', bill)).status).toBeGreaterThanOrEqual(500);
    expect(await grants()).toEqual([]);
  });
  it('expires an already-issued gift when cancellation arrives after its paid cutoff', async () => {
    await deliver('customer.subscription.created', subscription()); await deliver('invoice.paid', invoice());
    const cutoff = '2026-02-15T10:00:00.000Z';
    clock = new Date('2026-02-16T10:00:00.000Z');
    expect((await deliver('customer.subscription.deleted', { ...subscription(), status: 'canceled', current_period_end: epoch(cutoff) }, new Date(cutoff))).status).toBe(200);
    expect(await repo.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 0, remainingBalanceMicrousd: 0 });
    expect(await grants()).toHaveLength(1);
    expect((await grants())[0].expires_at).toBe('2026-02-28T10:00:00.000Z');
  });
  it('uses the paid billing anniversary when a trial began before its billing anchor', async () => {
    await deliver('customer.subscription.created', { ...subscription(), start_date: epoch('2026-01-01T10:00:00.000Z') });
    await deliver('invoice.paid', invoice());
    expect((await grants())[0].expires_at).toBe('2026-02-28T10:00:00.000Z');
  });
  it('accepts modern signed invoice subscription references without requiring legacy fields', async () => {
    await deliver('customer.subscription.created', subscription());
    const bill = invoice('in_modern');
    const old = bill.lines.data[0]!;
    const modern = { ...bill, subscription: undefined,
      parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_subscription' } },
      lines: { has_more: false, data: [{ amount: old.amount, period: old.period,
        parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_subscription' } },
        pricing: { price_details: { price: 'price_starter' } } }] } };
    expect((await deliver('invoice.paid', modern)).status).toBe(200);
    expect((await grants()).map(e => Number(e.amount_microusd))).toEqual([5_000_000]);
  });
  it('does not grant trial/past-due or stale subscription events, or reset the anchor on upgrade', async () => {
    await deliver('customer.subscription.created', { ...subscription(), status: 'trialing' });
    await deliver('invoice.paid', invoice()); expect(await grants()).toEqual([]);
    clock = new Date('2026-02-01T10:00:00.000Z');
    await deliver('customer.subscription.updated', subscription()); expect(await grants()).toHaveLength(1);
    await deliver('customer.subscription.updated', { ...subscription('price_max'), billing_cycle_anchor: epoch(clock.toISOString()) });
    await deliver('invoice.paid', invoice('in_upgrade_max', 'price_max'));
    expect((await grants()).map(e => Number(e.amount_microusd))).toEqual([5_000_000, 15_000_000]);
    expect((await grants())[1].expires_at).toBe('2026-02-28T10:00:00.000Z');
    await deliver('customer.subscription.updated', subscription('price_builder'), new Date(anchor));
    expect(await db.executor.selectFrom('ai_subscription_credit_terms').select(['anchor_at', 'observed_plan_slug']).executeTakeFirst())
      .toEqual({ anchor_at: anchor, observed_plan_slug: 'matrix_max' });
    clock = new Date('2026-03-01T12:00:00.000Z');
    await deliver('customer.subscription.updated', { ...subscription('price_max'), status: 'past_due' });
    expect(await grants()).toHaveLength(2);
  });
  it.each(['2026-02-27T10:00:00.000Z', '2026-02-28T10:00:00.000Z'])('applies a downgrade to the correct month despite delayed delivery: %s', async changedAt => {
    await deliver('customer.subscription.created', subscription('price_max'));
    await deliver('invoice.paid', invoice('in_max', 'price_max'));
    clock = new Date('2026-03-01T12:00:00.000Z');
    expect((await deliver('customer.subscription.updated', subscription('price_starter'), new Date(changedAt))).status).toBe(200);
    expect(await repo.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 5_000_000 });
    expect((await grants()).map(e => Number(e.amount_microusd))).toEqual([20_000_000, 5_000_000]);
  });
});
