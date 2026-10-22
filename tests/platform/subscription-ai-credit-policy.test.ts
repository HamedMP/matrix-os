import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { issueConfiguredSubscriptionAiCredit, loadSubscriptionAiCreditPolicy } from '../../packages/platform/src/subscription-ai-credit-policy.js';
import { insertUserMachine, upsertBillingSubscription, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const identity = { ownerId: 'subscriber', machineId: 'subscriber_machine', runtimeSlot: 'primary' };
const now = new Date('2026-10-22T18:00:00.000Z');
// Deliberately arbitrary fixture amounts: these are not approved product tiers.
const configuration = { version: 'fixture-policy-v1', plans: {
  matrix_starter: { amountMicrousd: 7_000_000, cadence: 'once', expiry: 'never' },
  matrix_builder: { amountMicrousd: 13_000_000, cadence: 'calendar_month', expiry: 'cycle_end' },
} };
const env = { MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED: 'true',
  MATRIX_AI_SUBSCRIPTION_CREDIT_POLICY_JSON: JSON.stringify(configuration) };

describe('explicit subscription AI credit configuration', () => {
  it('remains disabled without an explicit flag, even with amounts configured', () => {
    expect(loadSubscriptionAiCreditPolicy({})).toEqual({ enabled: false });
    expect(loadSubscriptionAiCreditPolicy({ MATRIX_AI_SUBSCRIPTION_CREDIT_POLICY_JSON: env.MATRIX_AI_SUBSCRIPTION_CREDIT_POLICY_JSON }))
      .toEqual({ enabled: false });
  });
  it.each([undefined, '{}', '{', JSON.stringify({ ...configuration, plans: { invented: configuration.plans.matrix_starter } }),
    JSON.stringify({ ...configuration, plans: { matrix_starter: { amountMicrousd: 5_000_000 } } })])
    ('rejects missing or ambiguous approved rules: %s', json => {
      expect(() => loadSubscriptionAiCreditPolicy({ ...env, MATRIX_AI_SUBSCRIPTION_CREDIT_POLICY_JSON: json })).toThrow(/configuration/);
    });
});

describe('subscription credit issuance foundation', () => {
  let db: PlatformDB;
  let repository: ReturnType<typeof createAiFundedPolicyRepository>;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId,
      handle: 'subscriber', status: 'running', activationState: 'authorized', provisioningClass: 'customer',
      runtimeSlot: 'primary', imageVersion: 'fixture', provisionedAt: now.toISOString() });
    repository = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => now });
    await repository.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: ['@cf/zai-org/glm-5.3-flash'] });
    await repository.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true,
      allowedModelIds: ['@cf/zai-org/glm-5.3-flash'], monthlyBudgetMicrousd: 0, budgetMode: 'credit_backed', expiresAt: null });
    await upsertBillingSubscription(db, { stripeSubscriptionId: 'sub_fixture', stripeCustomerId: 'cus_fixture',
      clerkUserId: identity.ownerId, runtimeSlot: 'primary', planSlug: 'matrix_starter', stripePriceId: 'price_fixture',
      billingInterval: 'monthly', status: 'active', currentPeriodEnd: '2026-12-01T00:00:00.000Z',
      gracePeriodEndsAt: null, latestEventCreatedAt: now.toISOString(), latestEventId: 'evt_fixture', updatedAt: now.toISOString() });
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  const issue = (at = now, configurationEnv = env, ownerIdentity = identity) => issueConfiguredSubscriptionAiCredit({
    db, repository, identity: ownerIdentity, env: configurationEnv, now: at });

  it('does not grant anything when configuration is disabled', async () => {
    expect(await issue(now, { ...env, MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED: 'false' })).toBe('disabled');
    expect(await repository.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 0 });
  });
  it('derives the plan from authoritative billing and grants a one-time owner entitlement once', async () => {
    expect(await issue()).toBe('accepted'); expect(await issue()).toBe('accepted');
    expect(await repository.getFundingSummary(identity)).toMatchObject({ promotionalBalanceMicrousd: 7_000_000,
      creditBalanceMicrousd: 7_000_000, monthlyBudgetMicrousd: 7_000_000 });
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toHaveLength(1);
  });
  it('supports only explicitly configured calendar-month/expiry rules without refilling the same month', async () => {
    await db.executor.updateTable('billing_subscriptions').set({ plan_slug: 'matrix_builder' }).execute();
    await issue(); await issue();
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').select(['amount_microusd', 'expires_at']).execute())
      .toEqual([{ amount_microusd: 13_000_000, expires_at: '2026-11-01T00:00:00.000Z' }]);
    await issue(new Date('2026-11-02T00:00:00.000Z'));
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll()
      .where('kind', '=', 'promotional_grant').execute()).toHaveLength(2);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').select(['kind', 'amount_microusd'])
      .where('kind', '=', 'promotional_expiry').execute()).toEqual([{ kind: 'promotional_expiry', amount_microusd: -13_000_000 }]);
    expect(await db.executor.selectFrom('ai_funded_runtime_balances').select('credit_balance_microusd').executeTakeFirstOrThrow())
      .toEqual({ credit_balance_microusd: 13_000_000 });
  });
  it('rejects once-to-monthly and later plan transitions until upgrade rules are approved', async () => {
    await issue();
    await db.executor.updateTable('billing_subscriptions').set({ plan_slug: 'matrix_builder' }).execute();
    expect(await issue()).toBe('ineligible');
    expect(await issue(new Date('2026-11-02T00:00:00.000Z'))).toBe('ineligible');
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toHaveLength(1);
    expect(await repository.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 7_000_000 });
  });
  it.each(['trialing', 'canceled', 'past_due'])('does not infer a paid allowance from %s status', async status => {
    await db.executor.updateTable('billing_subscriptions').set({ status }).execute();
    expect(await issue()).toBe('ineligible');
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toEqual([]);
  });
  it('refuses identity mismatch and disabled funded policy', async () => {
    expect(await issue(now, env, { ...identity, ownerId: 'another_owner' })).toBe('ineligible');
    await repository.updateGlobalPolicy({ expectedRevision: 1, enabled: false, allowedModelIds: [] });
    expect(await issue()).toBe('ineligible');
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toEqual([]);
  });
});
