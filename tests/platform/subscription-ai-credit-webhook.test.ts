import { loadStripePriceCatalog } from '../../packages/platform/src/billing.js';
import { hashAccountDeletionOwner } from '../../packages/platform/src/account-deletion/repository.js';
import { issueSubscriptionRuntimeCredit, recordSubscriptionCreditPayment, recordSubscriptionCreditTerms } from '../../packages/platform/src/subscription-ai-credit-billing.js';
import { Hono } from 'hono';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createBillingRoutes, type StripeBillingClient, type StripeWebhookEvent } from '../../packages/platform/src/billing-routes.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { insertUserMachine, upsertBillingCustomer, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { initializeCustomerFundedStarterPolicy } from '../../packages/platform/src/customer-funded-starter-policy.js';

{
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
  it.each([
    ['incomplete lines', (b: ReturnType<typeof invoice>) => ({ ...b, lines: { ...b.lines, has_more: true } })],
    ['not fully paid', (b: ReturnType<typeof invoice>) => ({ ...b, amount_paid: 1 })],
    ['wrong customer', (b: ReturnType<typeof invoice>) => ({ ...b, customer: 'cus_other' })],
    ['ambiguous priced lines', (b: ReturnType<typeof invoice>) => ({ ...b, lines: { ...b.lines, data: [b.lines.data[0], b.lines.data[0]] } })],
    ['invalid paid dates', (b: ReturnType<typeof invoice>) => ({ ...b, lines: { ...b.lines, data: [{ ...b.lines.data[0], period: { start: epoch(end), end: epoch(anchor) } }] } })],
  ] as const)('refuses invalid signed payment evidence without persisting a grant: %s', async (_name, change) => {
    await deliver('customer.subscription.created', subscription());
    expect((await deliver('invoice.paid', change(invoice()))).status).toBeGreaterThanOrEqual(500);
    expect(await grants()).toEqual([]);
    expect(await db.executor.selectFrom('ai_subscription_credit_payments').selectAll().execute()).toEqual([]);
  });
  it.each(['unknown-price', 'missing-price', 'negative-proration'] as const)('does not create paid coverage from %s', async kind => {
    await deliver('customer.subscription.created', subscription());
    const bill = invoice();
    const line = { ...bill.lines.data[0], price: kind === 'missing-price' ? undefined : { id: kind === 'unknown-price' ? 'price_unknown' : 'price_starter' }, amount: kind === 'negative-proration' ? -100 : 10000 };
    expect((await deliver('invoice.paid', { ...bill, lines: { ...bill.lines, data: [line] } })).status).toBe(200);
    expect(await grants()).toEqual([]);
  });
  it.each(['plan', 'from', 'until'] as const)('refuses altered immutable invoice coverage: %s', async field => {
    await deliver('customer.subscription.created', subscription()); await deliver('invoice.paid', invoice());
    const bill = invoice();
    if (field === 'plan') bill.lines.data[0]!.price.id = 'price_builder';
    if (field === 'from') bill.lines.data[0]!.period.start += 1;
    if (field === 'until') bill.lines.data[0]!.period.end -= 1;
    expect((await deliver('invoice.paid', bill)).status).toBeGreaterThanOrEqual(500);
    expect(await grants()).toHaveLength(1);
  });
  const context = () => ({ db, repository: repo, env, now: clock, changeAt: clock });
  const projection = () => ({ clerkUserId: identity.ownerId, stripeCustomerId: 'cus_subscription', stripeSubscriptionId: 'sub_subscription', status: 'active' as const, runtimeSlot: 'primary', items: [] });
  it('keeps all billing hooks disabled and refuses an enabled hook without a ledger', async () => {
    const disabled = { ...context(), env: {} };
    await issueSubscriptionRuntimeCredit(disabled, 'sub_subscription');
    await recordSubscriptionCreditTerms(disabled, projection(), {});
    await recordSubscriptionCreditPayment({ ...disabled, value: {}, priceCatalog: loadStripePriceCatalog(env) });
    await expect(recordSubscriptionCreditPayment({ ...context(), value: {}, priceCatalog: loadStripePriceCatalog(env) })).rejects.toThrow(/incomplete/);
    await expect(issueSubscriptionRuntimeCredit({ ...context(), repository: undefined }, 'sub_subscription')).rejects.toThrow(/ledger/);
    await issueSubscriptionRuntimeCredit(context(), 'sub_missing');
    expect(await grants()).toEqual([]);
  });
  it('waits for a running matching computer and refuses a projected identity mismatch', async () => {
    await deliver('customer.subscription.created', subscription());
    await db.executor.updateTable('user_machines').set({ status: 'stopped' }).execute();
    await issueSubscriptionRuntimeCredit(context(), 'sub_subscription');
    await expect(recordSubscriptionCreditTerms(context(), { ...projection(), runtimeSlot: 'secondary' }, {})).rejects.toThrow(/identity mismatch/);
    await db.executor.updateTable('billing_subscriptions').set({ runtime_slot: 'secondary' }).execute();
    await issueSubscriptionRuntimeCredit(context(), 'sub_subscription');
    await recordSubscriptionCreditTerms(context(), { ...projection(), runtimeSlot: 'secondary' }, {});
    expect(await grants()).toEqual([]);
  });
  it.each(['unknown-plan', 'no-anchor', 'future-anchor', 'start-date-fallback', 'no-paid-end'] as const)('records terms only from complete supported authority: %s', async kind => {
    await deliver('customer.subscription.created', subscription());
    await db.executor.deleteFrom('ai_subscription_credit_terms').execute();
    if (kind === 'unknown-plan') await db.executor.updateTable('billing_subscriptions').set({ plan_slug: 'unapproved' }).execute();
    if (kind === 'no-paid-end') await db.executor.updateTable('billing_subscriptions').set({ current_period_end: null }).execute();
    const raw = kind === 'no-anchor' ? {} : kind === 'future-anchor' ? { billing_cycle_anchor: epoch(end) }
      : kind === 'start-date-fallback' ? { start_date: epoch(anchor) } : { billing_cycle_anchor: epoch(anchor) };
    await recordSubscriptionCreditTerms(context(), projection(), raw);
    expect(await db.executor.selectFrom('ai_subscription_credit_terms').selectAll().execute())
      .toHaveLength(['start-date-fallback', 'no-paid-end'].includes(kind) ? 1 : 0);
    expect(await grants()).toEqual([]);
  });
  it('blocks terms and payment mutation during accepted account deletion', async () => {
    await deliver('customer.subscription.created', subscription());
    const secret = 'd'.repeat(32), at = clock.toISOString();
    await db.executor.insertInto('account_deletion_jobs').values({ owner_hash: hashAccountDeletionOwner(identity.ownerId, secret), status: 'scheduled', due_at: at, next_attempt_at: at, created_at: at, updated_at: at }).execute();
    const blocked = { ...context(), env: { ...env, ACCOUNT_DELETION_SECRET: secret } };
    await recordSubscriptionCreditTerms(blocked, projection(), {});
    await recordSubscriptionCreditPayment({ ...blocked, value: invoice(), priceCatalog: loadStripePriceCatalog(env) });
    expect(await grants()).toEqual([]);
    expect(await db.executor.selectFrom('ai_subscription_credit_payments').selectAll().execute()).toEqual([]);
  });
  it('requires reconciliation when cancellation encounters overlapping recorded cycles', async () => {
    await deliver('customer.subscription.created', subscription()); await deliver('invoice.paid', invoice());
    await db.executor.insertInto('ai_subscription_credit_cycles').values({ owner_id: identity.ownerId, runtime_slot: 'primary', subscription_id: 'sub_subscription', cycle_start: '2026-02-01T00:00:00.000Z', cycle_end: '2026-03-01T00:00:00.000Z', entitlement_microusd: 5_000_000, legacy_offset_microusd: 0, updated_at: anchor }).execute();
    await db.executor.updateTable('billing_subscriptions').set({ current_period_end: '2026-02-15T00:00:00.000Z' }).execute();
    await expect(recordSubscriptionCreditTerms(context(), projection(), subscription())).rejects.toThrow(/reconciliation/);
    expect(await grants()).toHaveLength(1);
  });
  it.each([false, true, 'settle'] as const)('reclaims a stale high-tier installment issued before a delayed downgrade while preserving holds=%s', async hold => {
    await deliver('customer.subscription.created', subscription('price_max'));
    await deliver('invoice.paid', invoice('in_max', 'price_max'));
    clock = new Date('2026-03-01T12:00:00.000Z');
    expect(await repo.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 20_000_000 });
    const issued = hold ? await repo.issueRuntimeCredential(identity) : undefined;
    const reserved = issued ? await repo.authorize({ credential: issued.credential.token, requestId: 'late-tier-hold',
      modelId: '@cf/zai-org/glm-5.3-flash', maxCostMicrousd: 10_000_000 }) : undefined;
    if (hold === 'settle' && issued && reserved) await repo.startReservation({ tokenId: issued.credential.tokenId, reservationId: reserved.reservation.reservationId });
    clock = new Date(hold ? '2026-03-01T12:01:00.000Z' : '2026-03-02T12:00:00.000Z');
    expect((await deliver('customer.subscription.updated', subscription(), new Date('2026-02-27T10:00:00.000Z'))).status).toBe(200);
    expect(await repo.getFundingSummary(identity)).toMatchObject(hold
      ? { creditBalanceMicrousd: 10_000_000, reservedMicrousd: 10_000_000, remainingBalanceMicrousd: 0 }
      : { creditBalanceMicrousd: 5_000_000, remainingBalanceMicrousd: 5_000_000 });
    if (issued && reserved) {
      const key = { tokenId: issued.credential.tokenId, reservationId: reserved.reservation.reservationId };
      if (hold === 'settle') await repo.settleReservation({ ...key, actualCostMicrousd: 3_000_000 });
      else await repo.releaseReservation({ ...key, reason: 'pre_upstream_failure' });
    }
    const expected = hold === 'settle' ? 2_000_000 : 5_000_000;
    expect(await repo.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: expected });
    // Repeating the same effective downgrade cannot refill spent/retired credit.
    await deliver('customer.subscription.updated', subscription(), new Date('2026-02-27T10:00:01.000Z'));
    expect(await repo.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: expected });
  });
  it.each([2_000_000, 8_000_000])('keeps settled cost %s and purchased funds while correcting a stale installment, then permits a legitimate upgrade', async actual => {
    await deliver('customer.subscription.created', subscription('price_max')); await deliver('invoice.paid', invoice('in_max', 'price_max'));
    clock = new Date('2026-03-01T12:00:00.000Z'); await repo.getFundingSummary(identity);
    await repo.grantCredit({ identity, entryId: 'addon:late-tier', kind: 'addon_grant', amountMicrousd: 10_000_000, sourceReference: 'fixture-purchase', expiresAt: null });
    const issued = await repo.issueRuntimeCredential(identity);
    const held = await repo.authorize({ credential: issued.credential.token, requestId: 'late-tier-settled', modelId: '@cf/zai-org/glm-5.3-flash', maxCostMicrousd: 10_000_000 });
    const key = { tokenId: issued.credential.tokenId, reservationId: held.reservation.reservationId };
    await repo.startReservation(key); await repo.settleReservation({ ...key, actualCostMicrousd: actual });
    clock = new Date('2026-03-02T12:00:00.000Z');
    await deliver('customer.subscription.updated', subscription(), new Date('2026-02-27T10:00:00.000Z'));
    expect(await repo.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 10_000_000 + Math.max(0, 5_000_000 - actual), addonBalanceMicrousd: 10_000_000, settledThisMonthMicrousd: actual, fundingShortfallMicrousd: 0 });
    clock = new Date('2026-03-03T12:00:00.000Z');
    await deliver('customer.subscription.updated', subscription('price_max'));
    expect(await repo.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 30_000_000 - actual, addonBalanceMicrousd: 10_000_000, settledThisMonthMicrousd: actual, fundingShortfallMicrousd: 0 });
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
}

{
const start = '2026-01-31T10:00:00.000Z', annualEnd = '2027-01-31T10:00:00.000Z';
const env = { MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED: 'true', MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: 'true',
  MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'true', AI_FUNDED_CREDENTIAL_HASH_SECRET: 'h'.repeat(32), STRIPE_WEBHOOK_SECRET: 'fixture',
  STRIPE_PRICE_MATRIX_STARTER_ANNUAL: 'price_starter', STRIPE_PRICE_MATRIX_BUILDER_ANNUAL: 'price_builder',
  STRIPE_PRICE_MATRIX_MAX_ANNUAL: 'price_max' };
const primary = { ownerId: 'owner', machineId: 'computer_primary', runtimeSlot: 'primary' };
const secondary = { ...primary, machineId: 'computer_secondary', runtimeSlot: 'computer-2' };
const epoch = (value: string) => Date.parse(value) / 1000;

describe('allowances per independently paid computer subscription', () => {
  let db: PlatformDB, app: Hono, clock: Date, event: StripeWebhookEvent, sequence: number;
  let repo: ReturnType<typeof createAiFundedPolicyRepository>;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb()); clock = new Date(start); sequence = 0;
    await upsertBillingCustomer(db, { clerkUserId: 'owner', stripeCustomerId: 'cus_owner', createdAt: start, updatedAt: start });
    for (const identity of [primary, secondary]) await insertUserMachine(db, { machineId: identity.machineId,
      clerkUserId: identity.ownerId, runtimeSlot: identity.runtimeSlot, handle: identity.runtimeSlot,
      status: 'running', activationState: 'authorized', provisioningClass: 'customer', imageVersion: 'fixture', provisionedAt: start });
    repo = createAiFundedPolicyRepository({ db, credentialHashSecret: env.AI_FUNDED_CREDENTIAL_HASH_SECRET,
      now: () => clock, subscriptionCreditEnv: env });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: ['@cf/zai-org/glm-5.3-flash'] });
    const unavailable = vi.fn().mockRejectedValue(new Error('Unexpected external Stripe call'));
    const stripe: StripeBillingClient = { apiTimeoutMs: 1000, createCheckoutSession: unavailable,
      retrieveCheckoutSession: unavailable, createPortalSession: unavailable, constructWebhookEvent: vi.fn(() => event) };
    app = new Hono().route('/billing', createBillingRoutes({ db, stripe, env, fundedAiRepository: repo,
      now: () => clock, resolveClerkUserId: async () => 'owner' }));
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  async function deliver(type: string, object: unknown) {
    event = { id: `evt_computers_${++sequence}`, type, created: Math.floor(clock.getTime() / 1000), data: { object } };
    const response = await app.request('/billing/webhooks/stripe', { method: 'POST', headers: { 'stripe-signature': 'fixture' }, body: '{}' });
    expect(response.status).toBe(200);
  }
  const subscription = (slot: string, price = 'price_starter', anchor = start) => ({ id: `sub_${slot}`, customer: 'cus_owner', status: 'active',
    billing_cycle_anchor: epoch(anchor), current_period_end: epoch(annualEnd), metadata: { clerk_user_id: 'owner', matrix_runtime_slot: slot },
    items: { data: [{ price: { id: price, unit_amount: 10000, currency: 'usd', recurring: { interval: 'year', interval_count: 1 } }, quantity: 1 }] } });
  const invoice = (slot: string, price = 'price_starter', anchor = start) => ({ id: `in_${slot}_${price}`, customer: 'cus_owner', subscription: `sub_${slot}`,
    status: 'paid', amount_due: 10000, amount_paid: 10000, currency: 'usd', billing_reason: 'subscription_cycle', created: epoch(start),
    lines: { has_more: false, data: [{ amount: 10000, type: 'subscription', subscription: `sub_${slot}`,
      price: { id: price }, period: { start: epoch(anchor), end: epoch(annualEnd) } }] } });
  const initialize = (identity = secondary, flags: NodeJS.ProcessEnv = env) => initializeCustomerFundedStarterPolicy(db, identity.machineId, { now: clock.toISOString(), env: flags });
  const policies = () => db.executor.selectFrom('ai_funded_runtime_policies').selectAll().orderBy('runtime_slot').execute();
  const grants = () => db.executor.selectFrom('ai_funded_credit_ledger').selectAll().where('kind', '=', 'promotional_grant').execute();
  async function enroll(slot: string, price = 'price_starter', anchor = start) {
    await deliver('customer.subscription.created', subscription(slot, price, anchor));
    await deliver('invoice.paid', invoice(slot, price, anchor));
  }

  it('initializes a second paid computer through signed billing without consuming the primary lifetime offset', async () => {
    await initialize(primary, { ...env, MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED: 'false' });
    await enroll('primary');
    await enroll('computer-2', 'price_builder', '2026-01-15T10:00:00.000Z');
    await deliver('invoice.paid', invoice('computer-2', 'price_builder', '2026-01-15T10:00:00.000Z'));
    await Promise.all([initialize(), initialize()]);
    expect(await policies()).toEqual([expect.objectContaining({ runtime_slot: 'computer-2', budget_mode: 'credit_backed', monthly_budget_microusd: 10_000_000 }),
      expect.objectContaining({ runtime_slot: 'primary', monthly_budget_microusd: 5_000_000 })]);
    expect((await grants()).map(g => [g.runtime_slot, Number(g.amount_microusd)])).toEqual([['primary', 5_000_000], ['computer-2', 10_000_000]]);
    expect(await db.executor.selectFrom('ai_subscription_credit_cycles').select(['runtime_slot', 'legacy_offset_microusd', 'cycle_end']).orderBy('runtime_slot').execute()).toEqual([
      { runtime_slot: 'computer-2', legacy_offset_microusd: 0, cycle_end: '2026-02-15T10:00:00.000Z' },
      { runtime_slot: 'primary', legacy_offset_microusd: 5_000_000, cycle_end: '2026-02-28T10:00:00.000Z' }]);
  });
  it('isolates secondary upgrade, cancellation and expiry from the primary balance and anniversary', async () => {
    await enroll('primary'); await enroll('computer-2', 'price_builder', '2026-01-15T10:00:00.000Z');
    clock = new Date('2026-02-01T10:00:00.000Z');
    await deliver('customer.subscription.updated', subscription('computer-2', 'price_max', '2026-01-15T10:00:00.000Z'));
    await deliver('invoice.paid', invoice('computer-2', 'price_max', '2026-01-15T10:00:00.000Z'));
    expect(await repo.getFundingSummary(secondary)).toMatchObject({ creditBalanceMicrousd: 20_000_000 });
    await deliver('customer.subscription.updated', { ...subscription('computer-2', 'price_max'), status: 'canceled', current_period_end: epoch('2026-02-03T10:00:00.000Z') });
    clock = new Date('2026-02-04T10:00:00.000Z');
    expect(await repo.getFundingSummary(secondary)).toMatchObject({ creditBalanceMicrousd: 0 });
    expect(await repo.getFundingSummary(primary)).toMatchObject({ creditBalanceMicrousd: 5_000_000 });
    expect((await grants()).filter(g => g.runtime_slot === 'primary')).toHaveLength(1);
  });
  it('keeps another owner with the same runtime slot and anniversary on a separate entitlement', async () => {
    await enroll('computer-2', 'price_builder');
    const other = { ownerId: 'other_owner', machineId: 'other_computer', runtimeSlot: 'computer-2' };
    await upsertBillingCustomer(db, { clerkUserId: other.ownerId, stripeCustomerId: 'cus_other', createdAt: start, updatedAt: start });
    await insertUserMachine(db, { machineId: other.machineId, clerkUserId: other.ownerId, runtimeSlot: other.runtimeSlot,
      handle: 'other-computer', status: 'running', activationState: 'authorized', provisioningClass: 'customer', imageVersion: 'fixture', provisionedAt: start });
    await deliver('customer.subscription.created', { ...subscription('computer-2', 'price_max'), id: 'sub_other', customer: 'cus_other',
      metadata: { clerk_user_id: other.ownerId, matrix_runtime_slot: other.runtimeSlot } });
    const bill = invoice('computer-2', 'price_max');
    await deliver('invoice.paid', { ...bill, id: 'in_other', customer: 'cus_other', subscription: 'sub_other',
      lines: { has_more: false, data: [{ ...bill.lines.data[0]!, subscription: 'sub_other' }] } });
    expect(await repo.getFundingSummary(secondary)).toMatchObject({ creditBalanceMicrousd: 10_000_000 });
    expect(await repo.getFundingSummary(other)).toMatchObject({ creditBalanceMicrousd: 20_000_000 });
    expect(await grants()).toHaveLength(2);
    expect(new Set((await grants()).map(g => g.entry_id)).size).toBe(2);
  });
  it('waits for paid coverage and running activation before creating a secondary policy', async () => {
    await deliver('customer.subscription.created', subscription('computer-2', 'price_builder'));
    expect(await initialize()).toBe(false); expect(await policies()).toEqual([]);
    await db.executor.updateTable('user_machines').set({ status: 'provisioning' }).where('machine_id', '=', secondary.machineId).execute();
    await deliver('invoice.paid', invoice('computer-2', 'price_builder'));
    expect(await policies()).toEqual([]);
    await db.executor.updateTable('user_machines').set({ status: 'running' }).where('machine_id', '=', secondary.machineId).execute();
    expect(await initialize()).toBe(true);
    expect(await repo.getFundingSummary(secondary)).toMatchObject({ creditBalanceMicrousd: 10_000_000 });
  });
  it('keeps legacy lifetime starter eligibility primary-only while subscription issuance is disabled', async () => {
    const flags = { ...env, MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED: 'false' };
    expect(await initialize(secondary, flags)).toBe(false);
    expect(await policies()).toEqual([]);
    expect(await initialize(primary, flags)).toBe(true);
    expect((await grants()).map(g => g.runtime_slot)).toEqual(['primary']);
  });
  it.each([true, false])('preserves an existing operator policy (enabled=%s), including its fixed ceiling', async enabled => {
    await repo.setRuntimePolicy({ identity: secondary, expectedRevision: 0, enabled, budgetMode: 'fixed', monthlyBudgetMicrousd: 123,
      allowedModelIds: ['@cf/zai-org/glm-5.3-flash'], expiresAt: null });
    const before = await policies(); await enroll('computer-2', 'price_builder');
    expect(await initialize()).toBe(false); expect(await policies()).toEqual(before);
    expect((await grants()).map(g => Number(g.amount_microusd))).toEqual(enabled ? [10_000_000] : []);
  });
  it.each(['no-anchor', 'preview', 'unpaid'] as const)('does not initialize an ineligible paid-computer claim: %s', async kind => {
    await deliver('customer.subscription.created', { ...subscription('computer-2'),
      ...(kind === 'no-anchor' ? { billing_cycle_anchor: undefined } : kind === 'unpaid' ? { status: 'trialing' } : {}) });
    if (kind === 'preview') await db.executor.updateTable('user_machines').set({ provisioning_class: 'preview' }).where('machine_id', '=', secondary.machineId).execute();
    await deliver('invoice.paid', invoice('computer-2'));
    expect(await initialize()).toBe(false); expect(await policies()).toEqual([]); expect(await grants()).toEqual([]);
  });
});
}
