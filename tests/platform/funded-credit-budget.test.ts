import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { isAiCreditCheckoutRouteHealthy } from '../../packages/platform/src/ai-credit-checkout-readiness.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const identity = { ownerId: 'credit_owner', machineId: 'credit_machine', runtimeSlot: 'primary' };
const at = '2026-10-22T18:00:00.000Z';

describe('credit-backed funded spending budgets', () => {
  let db: PlatformDB;
  let repository: ReturnType<typeof createAiFundedPolicyRepository>;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, { ...{ machineId: identity.machineId, clerkUserId: identity.ownerId },
      handle: 'credit-owner', runtimeSlot: 'primary', status: 'running', activationState: 'authorized',
      imageVersion: 'test', provisionedAt: at });
    repository = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => new Date(at) });
    await repository.updateGlobalPolicy({ expectedRevision: 0, enabled: true,
      allowedModelIds: ['@cf/zai-org/glm-5.3-flash'] });
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  const policy = (budgetMode?: 'fixed' | 'credit_backed') => repository.setRuntimePolicy({ identity,
    expectedRevision: 0, enabled: true, allowedModelIds: ['@cf/zai-org/glm-5.3-flash'],
    monthlyBudgetMicrousd: 5_000_000, expiresAt: null, ...(budgetMode ? { budgetMode } : {}) });
  const grant = (entryId: string, amountMicrousd = 10_000_000) => repository.grantCredit({
    identity, entryId, kind: 'addon_grant', amountMicrousd, sourceReference: entryId, expiresAt: null });

  it('allows purchased credit beyond the original starter ceiling without minting funds', async () => {
    await policy('credit_backed');
    await repository.grantCredit({ identity, entryId: 'starter', kind: 'promotional_grant',
      amountMicrousd: 5_000_000, sourceReference: 'starter', expiresAt: null });
    await grant('addon:test');
    expect(await repository.getFundingSummary(identity)).toMatchObject({
      creditBalanceMicrousd: 15_000_000, monthlyBudgetMicrousd: 15_000_000,
      remainingBalanceMicrousd: 15_000_000, remainingBudgetMicrousd: 15_000_000 });
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toHaveLength(2);
    const issued = await repository.issueRuntimeCredential(identity);
    const admitted = await repository.authorize({ credential: issued.credential.token, requestId: 'above-starter',
      modelId: '@cf/zai-org/glm-5.3-flash', maxCostMicrousd: 6_000_000 });
    expect(admitted).toMatchObject({ authorized: true, reservation: { reservedMicrousd: 6_000_000 } });
  });

  it('preserves explicit fixed caps even when credit exceeds the cap', async () => {
    await policy(); await grant('addon:fixed');
    expect(await repository.getFundingSummary(identity)).toMatchObject({
      creditBalanceMicrousd: 10_000_000, monthlyBudgetMicrousd: 5_000_000 });
    const issued = await repository.issueRuntimeCredential(identity);
    await expect(repository.authorize({ credential: issued.credential.token, requestId: 'fixed-over-cap',
      modelId: '@cf/zai-org/glm-5.3-flash', maxCostMicrousd: 6_000_000 })).rejects.toMatchObject({ code: 'budget_exceeded' });
  });

  it('does not raise a budget again on duplicate grant delivery', async () => {
    await policy('credit_backed'); await grant('addon:duplicate');
    const before = await repository.getRuntimePolicy(identity);
    await grant('addon:duplicate');
    expect(await repository.getRuntimePolicy(identity)).toEqual(before);
    expect(await repository.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 10_000_000,
      monthlyBudgetMicrousd: 10_000_000 });
  });
  it('aligns both runtimes when an owner-wide promotion hands off its remaining credit', async () => {
    await policy('credit_backed');
    const target = { ...identity, machineId: 'credit_target', runtimeSlot: 'secondary' };
    await insertUserMachine(db, { machineId: target.machineId, clerkUserId: target.ownerId, handle: 'credit-target',
      runtimeSlot: target.runtimeSlot, status: 'running', activationState: 'authorized', imageVersion: 'test', provisionedAt: at });
    await repository.setRuntimePolicy({ identity: target, expectedRevision: 0, enabled: true,
      allowedModelIds: ['@cf/zai-org/glm-5.3-flash'], monthlyBudgetMicrousd: 0, budgetMode: 'credit_backed', expiresAt: null });
    const promotion = { entryId: 'promotion:handoff', kind: 'promotional_grant' as const,
      amountMicrousd: 5_000_000, sourceReference: 'owner-promotion', expiresAt: null };
    await repository.grantCredit({ ...promotion, identity });
    await repository.grantCredit({ ...promotion, identity: target });
    expect(await repository.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 0, monthlyBudgetMicrousd: 0 });
    expect(await repository.getFundingSummary(target)).toMatchObject({ creditBalanceMicrousd: 5_000_000, monthlyBudgetMicrousd: 5_000_000 });
    const before = await repository.getRuntimePolicy(target);
    await repository.grantCredit({ ...promotion, identity: target });
    expect(await repository.getRuntimePolicy(target)).toEqual(before);
  });

  it('aligns already purchased credit only after an explicit revisioned budget-mode change', async () => {
    await policy(); await grant('addon:existing');
    const result = await repository.setRuntimePolicy({ identity, expectedRevision: 1,
      enabled: true, allowedModelIds: ['@cf/zai-org/glm-5.3-flash'],
      monthlyBudgetMicrousd: 5_000_000, budgetMode: 'credit_backed', expiresAt: null });
    expect(result).toMatchObject({ monthlyBudgetMicrousd: 10_000_000, budgetMode: 'credit_backed' });
    expect(await repository.getRuntimePolicy(identity)).toMatchObject(result);
  });

  it('rolls back the grant and budget together if the theoretical cap exceeds safe integer accounting', async () => {
    await policy('credit_backed');
    await db.executor.updateTable('ai_funded_runtime_balances').set({ month_spent_microusd: Number.MAX_SAFE_INTEGER }).execute();
    await expect(grant('addon:overflow', 1)).rejects.toThrow(/safe integer/);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toEqual([]);
    expect(await repository.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 0 });
  });

  it('accounts for current spend, holds and shortfall without resetting any counters', async () => {
    await policy('credit_backed');
    await db.executor.updateTable('ai_funded_runtime_balances').set({
      credit_balance_microusd: 1_000_000, promotional_balance_microusd: 1_000_000,
      reserved_microusd: 200_000, month_reserved_microusd: 200_000,
      month_spent_microusd: 4_000_000, funding_shortfall_microusd: 100_000 }).execute();
    await grant('addon:held');
    expect(await repository.getFundingSummary(identity)).toMatchObject({ monthlyBudgetMicrousd: 14_900_000,
      creditBalanceMicrousd: 11_000_000, remainingBudgetMicrousd: 10_700_000,
      remainingBalanceMicrousd: 10_700_000, reservedMicrousd: 200_000,
      settledThisMonthMicrousd: 4_000_000, fundingShortfallMicrousd: 100_000 });
  });
  it('derives the current-month ceiling for checkout, funding reads and admission after rollover', async () => {
    await policy('credit_backed'); await grant('addon:rollover', 5_000_000);
    await db.executor.updateTable('ai_funded_runtime_balances').set({ credit_balance_microusd: 1_000_000,
      addon_balance_microusd: 1_000_000, month_spent_microusd: 4_000_000 }).execute();
    const next = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => new Date('2026-11-01T00:00:01.000Z') });
    const before = await db.executor.selectFrom('ai_funded_runtime_balances').selectAll().execute();
    expect(await next.getCheckoutFundingSummary(identity, Date.now() + 5000, { projectExpiredCredit: true }))
      .toMatchObject({ funding: { monthlyBudgetMicrousd: 1_000_000, remainingBudgetMicrousd: 1_000_000 },
        policy: { monthlyBudgetMicrousd: 1_000_000 } });
    expect(await db.executor.selectFrom('ai_funded_runtime_balances').selectAll().execute()).toEqual(before);
    expect(await next.getFundingSummary(identity)).toMatchObject({ monthlyBudgetMicrousd: 1_000_000, settledThisMonthMicrousd: 0 });
    const issued = await next.issueRuntimeCredential(identity);
    expect(await next.authorize({ credential: issued.credential.token, requestId: 'rollover-admit',
      modelId: '@cf/zai-org/glm-5.3-flash', maxCostMicrousd: 1 })).toMatchObject({
      funding: { monthlyBudgetMicrousd: 1_000_000, remainingBudgetMicrousd: 999_999 },
      policy: { monthlyBudgetMicrousd: 1_000_000 } });
  });
  it('projects promotional expiry into the effective ceiling without checkout writes', async () => {
    await policy('credit_backed'); await grant('addon:expiry');
    await repository.grantCredit({ identity, entryId: 'expiring', kind: 'promotional_grant',
      amountMicrousd: 5_000_000, sourceReference: 'expiry', expiresAt: '2026-10-23T00:00:00.000Z' });
    const later = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => new Date('2026-10-24T00:00:00.000Z') });
    const before = await db.executor.selectFrom('ai_funded_runtime_balances').selectAll().execute();
    expect(await later.getCheckoutFundingSummary(identity, Date.now() + 5000, { projectExpiredCredit: true }))
      .toMatchObject({ funding: { monthlyBudgetMicrousd: 10_000_000, creditBalanceMicrousd: 10_000_000 } });
    expect(await db.executor.selectFrom('ai_funded_runtime_balances').selectAll().execute()).toEqual(before);
    expect(await later.getFundingSummary(identity)).toMatchObject({ monthlyBudgetMicrousd: 10_000_000, creditBalanceMicrousd: 10_000_000 });
  });

  it.each(['credit_backed', 'fixed'] as const)('allows an exhausted %s budget to buy only when purchases can restore it', async mode => {
    await policy(mode);
    await db.executor.updateTable('ai_funded_runtime_balances').set({ month_spent_microusd: 5_000_000 }).execute();
    let probes = 0;
    const before = await repository.getFundingSummary(identity);
    expect(await isAiCreditCheckoutRouteHealthy({ repository, identity, now: () => new Date(at),
      modelProbes: { probe: async () => { probes++; return { ready: true, checkedAt: at,
        staleAfter: '2026-10-22T18:00:30.000Z' }; } } })).toBe(mode === 'credit_backed');
    expect(probes).toBe(mode === 'credit_backed' ? 1 : 0);
    expect(await repository.getFundingSummary(identity)).toEqual(before);
  });
});
