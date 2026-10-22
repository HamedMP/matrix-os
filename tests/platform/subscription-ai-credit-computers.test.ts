import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createBillingRoutes, type StripeBillingClient, type StripeWebhookEvent } from '../../packages/platform/src/billing-routes.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { initializeCustomerFundedStarterPolicy } from '../../packages/platform/src/customer-funded-starter-policy.js';
import { insertUserMachine, upsertBillingCustomer, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

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
