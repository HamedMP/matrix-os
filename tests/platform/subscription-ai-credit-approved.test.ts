import { hashAccountDeletionOwner } from '../../packages/platform/src/account-deletion/repository.js';
import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { issueConfiguredSubscriptionAiCredit, loadSubscriptionAiCreditPolicy, shortenSubscriptionCreditCycle } from '../../packages/platform/src/subscription-ai-credit-policy.js';
import { createPlatformDb, insertUserMachine, upsertBillingCustomer, upsertBillingSubscription, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { subscriptionCreditCycle } from '../../packages/platform/src/subscription-ai-credit-cycle.js';
import { isAiCreditCheckoutRouteHealthy } from '../../packages/platform/src/ai-credit-checkout-readiness.js';
import { Hono } from 'hono';
import { loadAiCreditCheckoutConfig } from '../../packages/platform/src/ai-credit-checkout.js';
import { createAiCreditCheckoutHandler } from '../../packages/platform/src/billing/ai-credit-checkout-route.js';
import { createAiFundedRuntimeRoutes } from '../../packages/platform/src/ai-funded-policy-routes.js';
import { buildPlatformRuntimeVerificationToken } from '../../packages/platform/src/platform-token.js';

{
{
const identity = { ownerId: 'approved_owner', machineId: 'approved_machine', runtimeSlot: 'primary' };
const anchor = '2026-01-31T10:00:00.000Z';
const env = { MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED: 'true' };
const amounts = { matrix_starter: 5_000_000, matrix_builder: 10_000_000, matrix_max: 20_000_000 };

it('uses the requester-approved tiers only after explicit activation', () => {
  expect(loadSubscriptionAiCreditPolicy({})).toEqual({ enabled: false });
  expect(loadSubscriptionAiCreditPolicy(env)).toMatchObject({ enabled: true, amountsMicrousd: amounts });
});

describe('approved subscription-month allowances', () => {
  let db: PlatformDB;
  let repo: ReturnType<typeof createAiFundedPolicyRepository>;
  let clock: Date;
  let secondDb: PlatformDB | undefined;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb()); clock = new Date(anchor);
    await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: identity.ownerId,
      handle: 'approved-owner', status: 'running', activationState: 'authorized', provisioningClass: 'customer',
      runtimeSlot: 'primary', imageVersion: 'fixture', provisionedAt: anchor });
    await upsertBillingCustomer(db, { clerkUserId: identity.ownerId, stripeCustomerId: 'cus_approved', createdAt: anchor, updatedAt: anchor });
    await upsertBillingSubscription(db, { stripeSubscriptionId: 'sub_approved', stripeCustomerId: 'cus_approved',
      clerkUserId: identity.ownerId, runtimeSlot: 'primary', planSlug: 'matrix_starter', stripePriceId: 'price_starter',
      billingInterval: 'annual', status: 'active', currentPeriodEnd: '2027-01-31T10:00:00.000Z',
      gracePeriodEndsAt: null, latestEventCreatedAt: anchor, latestEventId: 'evt_subscription', updatedAt: anchor });
    repo = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => clock });
    await repo.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: ['@cf/zai-org/glm-5.3-flash'] });
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, budgetMode: 'credit_backed',
      allowedModelIds: ['@cf/zai-org/glm-5.3-flash'], monthlyBudgetMicrousd: 0, expiresAt: null });
    await db.executor.insertInto('ai_subscription_credit_terms').values({ subscription_id: 'sub_approved',
      owner_id: identity.ownerId, runtime_slot: 'primary', anchor_at: anchor, observed_plan_slug: 'matrix_starter',
      floor_cycle_start: anchor, floor_microusd: 5_000_000, updated_at: anchor }).execute();
    await pay('matrix_starter');
  });
  afterEach(async () => { await secondDb?.destroy(); secondDb = undefined; await destroyTestPlatformDb(db); });
  const issue = () => issueConfiguredSubscriptionAiCredit({ db, repository: repo, identity, env, now: clock });
  async function pay(plan: keyof typeof amounts, end = '2027-01-31T10:00:00.000Z') {
    await db.executor.insertInto('ai_subscription_credit_payments').values({ invoice_id: `invoice_${plan}`,
      subscription_id: 'sub_approved', owner_id: identity.ownerId, plan_slug: plan,
      paid_from: anchor, paid_until: end, created_at: clock.toISOString() }).execute();
  }
  async function plan(plan: keyof typeof amounts, floor = amounts[plan]) {
    await db.executor.updateTable('billing_subscriptions').set({ plan_slug: plan }).execute();
    await db.executor.updateTable('ai_subscription_credit_terms').set({ observed_plan_slug: plan, floor_microusd: floor }).execute();
  }
  const entries = () => db.executor.selectFrom('ai_funded_credit_ledger').selectAll().where('kind', '=', 'promotional_grant').execute();

  it('grants one monthly installment with end-of-month clamping, despite annual payment', async () => {
    if (process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL) {
      // Open an independent pool to the same disposable clone, then observe the
      // actual advisory-lock wait before checking rows and releasing the owner.
      const name = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db.executor);
      const url = new URL(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL);
      url.pathname = `/${name.rows[0]!.name}`;
      url.searchParams.set('application_name', 'subscription_credit_contender');
      secondDb = createPlatformDb(url.href); await secondDb.ready;
      const otherRepo = createAiFundedPolicyRepository({ db: secondDb, credentialHashSecret: 'h'.repeat(32), now: () => clock });
      let pending: Promise<unknown> | undefined;
      try {
        await db.transaction(async trx => {
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${identity.ownerId}`}, 0))`.execute(trx.executor);
          pending = issueConfiguredSubscriptionAiCredit({ db: secondDb!, repository: otherRepo, identity, env, now: clock });
          await vi.waitFor(async () => {
            const waiting = await sql<{ count: number }>`SELECT count(*)::int AS count FROM pg_locks l
              JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND NOT l.granted
              AND a.application_name='subscription_credit_contender'`.execute(trx.executor);
            expect(waiting.rows[0]!.count).toBeGreaterThan(0);
          }, { timeout: 3000, interval: 25 });
          await trx.executor.selectFrom('user_machines').select('machine_id').where('machine_id', '=', identity.machineId)
            .forUpdate().noWait().executeTakeFirstOrThrow();
        });
        await expect(pending).resolves.toBe('accepted');
        await Promise.all([issue(), issueConfiguredSubscriptionAiCredit({ db: secondDb, repository: otherRepo, identity, env, now: clock })]);
      } finally { if (pending) await Promise.allSettled([pending]); }
    } else { await issue(); await issue(); await issue(); }
    expect(await entries()).toMatchObject([{ amount_microusd: 5_000_000, expires_at: '2026-02-28T10:00:00.000Z' }]);
    expect(await db.executor.selectFrom('ai_subscription_credit_cycles').selectAll().execute()).toHaveLength(1);
    clock = new Date('2026-03-01T12:00:00.000Z'); await issue();
    expect(await entries()).toHaveLength(2);
    expect((await entries())[1]).toMatchObject({ expires_at: '2026-03-31T10:00:00.000Z' });
    expect(await repo.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 5_000_000, monthlyBudgetMicrousd: 5_000_000 });
  });
  it.skipIf(!process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL)('shares the global policy with unrelated readers while still serializing policy writes', async () => {
    const name = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db.executor);
    const url = new URL(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL!);
    url.pathname = `/${name.rows[0]!.name}`; url.searchParams.set('application_name', 'subscription_global_reader');
    secondDb = createPlatformDb(url.href); await secondDb.ready;
    const otherRepo = createAiFundedPolicyRepository({ db: secondDb, credentialHashSecret: 'h'.repeat(32), now: () => clock });
    let issuance: Promise<unknown> | undefined, write: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await db.transaction(async trx => {
        await trx.executor.selectFrom('ai_funded_global_policy').select('enabled').where('policy_id', '=', 'default').forShare().executeTakeFirstOrThrow();
        issuance = issueConfiguredSubscriptionAiCredit({ db: secondDb!, repository: otherRepo, identity, env, now: clock });
        const completed = await Promise.race([issuance, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Unrelated global policy reader blocked issuance')), 3000); })]);
        clearTimeout(timer); expect(completed).toBe('accepted');
        write = otherRepo.updateGlobalPolicy({ expectedRevision: 1, enabled: false, allowedModelIds: [] });
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: number }>`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE application_name='subscription_global_reader' AND wait_event_type='Lock'`.execute(trx.executor);
          expect(waiting.rows[0]!.count).toBeGreaterThan(0);
        }, { timeout: 3000, interval: 25 });
        expect((await trx.executor.selectFrom('ai_funded_global_policy').select('enabled').executeTakeFirstOrThrow()).enabled).toBe(true);
      });
      await expect(write).resolves.toMatchObject({ enabled: false });
      expect(await entries()).toHaveLength(1);
    } finally { if (timer) clearTimeout(timer); await Promise.allSettled([issuance, write].filter((p): p is Promise<unknown> => p !== undefined)); }
  });
  it('tops up an upgrade only after payment coverage and defers a downgrade until next month', async () => {
    await issue(); await plan('matrix_builder');
    await issue(); expect(await entries()).toHaveLength(1);
    await pay('matrix_builder'); await issue(); await issue();
    expect((await entries()).map(e => Number(e.amount_microusd))).toEqual([5_000_000, 5_000_000]);
    await plan('matrix_starter', 10_000_000); await issue();
    expect(await repo.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 10_000_000 });
    clock = new Date('2026-02-28T10:00:01.000Z'); await issue();
    expect(await repo.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 5_000_000 });
  });
  it('counts the historical $5 in the first installment and expires only its unspent remainder', async () => {
    await repo.grantCredit({ identity, entryId: `starter-lifetime:${createHash('sha256').update(identity.ownerId).digest('hex')}`,
      kind: 'promotional_grant', amountMicrousd: 5_000_000, sourceReference: 'matrix-ai-lifetime-starter', expiresAt: null });
    await plan('matrix_builder'); await pay('matrix_builder'); await issue();
    expect((await entries()).map(e => Number(e.amount_microusd))).toEqual([5_000_000, 5_000_000]);
    expect(await db.executor.selectFrom('ai_funded_promotional_grant_balances').select('expires_at').execute())
      .toEqual([{ expires_at: '2026-02-28T10:00:00.000Z' }, { expires_at: '2026-02-28T10:00:00.000Z' }]);
    // Original ledger grant remains immutable even after its remainder is enrolled.
    expect((await entries())[0].expires_at).toBeNull();
    clock = new Date('2026-02-28T10:00:01.000Z'); await issue();
    expect(await repo.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 10_000_000 });
  });
  it('preserves purchased credit and stops installments at the paid cancellation boundary', async () => {
    await repo.grantCredit({ identity, entryId: 'addon:approved', kind: 'addon_grant', amountMicrousd: 10_000_000,
      sourceReference: 'paid_fixture', expiresAt: null });
    await db.executor.updateTable('billing_subscriptions').set({ status: 'canceled', current_period_end: '2026-03-15T10:00:00.000Z' }).execute();
    clock = new Date('2026-03-01T00:00:00.000Z'); await issue();
    expect((await entries())[0].expires_at).toBe('2026-03-15T10:00:00.000Z');
    clock = new Date('2026-03-15T10:00:00.000Z'); expect(await issue()).toBe('ineligible');
    expect(await repo.getFundingSummary(identity)).toMatchObject({ creditBalanceMicrousd: 10_000_000, addonBalanceMicrousd: 10_000_000 });
  });
  it('shortens an already-issued installment at the paid cancellation boundary without minting or losing holds', async () => {
    await issue();
    const issued = await repo.issueRuntimeCredential(identity);
    const held = await repo.authorize({ credential: issued.credential.token, requestId: 'canceled-held-turn',
      modelId: '@cf/zai-org/glm-5.3-flash', maxCostMicrousd: 1_000_000 });
    const cutoff = '2026-02-15T10:00:00.000Z';
    await db.executor.updateTable('billing_subscriptions').set({ status: 'canceled', current_period_end: cutoff }).execute();
    expect(await issue()).toBe('accepted');
    expect(await entries()).toHaveLength(1);
    expect((await entries())[0].expires_at).toBe('2026-02-28T10:00:00.000Z');
    expect(await db.executor.selectFrom('ai_funded_promotional_grant_balances').select('expires_at').execute())
      .toEqual([{ expires_at: cutoff }]);
    expect(await repo.getFundingSummary(identity)).toMatchObject({ reservedMicrousd: 1_000_000, creditBalanceMicrousd: 5_000_000 });
    clock = new Date(cutoff);
    expect(await issue()).toBe('ineligible');
    expect(await repo.getFundingSummary(identity)).toMatchObject({ reservedMicrousd: 1_000_000, remainingBalanceMicrousd: 0 });
    expect(held.authorized).toBe(true);
  });
  it.each([
    ['wrong machine slot', async () => { await db.executor.updateTable('user_machines').set({ runtime_slot: 'other' }).execute(); }],
    ['stopped computer', async () => { await db.executor.updateTable('user_machines').set({ status: 'stopped' }).execute(); }],
    ['unauthorized computer', async () => { await db.executor.updateTable('user_machines').set({ activation_state: 'awaiting_payment' }).execute(); }],
    ['noncustomer computer', async () => { await db.executor.updateTable('user_machines').set({ provisioning_class: 'preview' }).execute(); }],
    ['deleted computer', async () => { await db.executor.updateTable('user_machines').set({ deleted_at: anchor }).execute(); }],
    ['wrong policy owner', async () => { await db.executor.updateTable('ai_funded_runtime_policies').set({ owner_id: 'other' }).execute(); }],
    ['wrong policy slot', async () => { await db.executor.updateTable('ai_funded_runtime_policies').set({ runtime_slot: 'other' }).execute(); }],
    ['expired policy', async () => { await db.executor.updateTable('ai_funded_runtime_policies').set({ expires_at: anchor }).execute(); }],
    ['disjoint models', async () => { await db.executor.updateTable('ai_funded_runtime_policies').set({ allowed_model_ids: '["@cf/openai/gpt-oss-20b"]' }).execute(); }],
    ['missing terms', async () => { await db.executor.deleteFrom('ai_subscription_credit_terms').execute(); }],
    ['unsupported plan', async () => { await db.executor.updateTable('billing_subscriptions').set({ plan_slug: 'unapproved' }).execute(); }],
    ['future anchor', async () => { await db.executor.updateTable('ai_subscription_credit_terms').set({ anchor_at: '2026-02-28T10:00:00.000Z' }).execute(); }],
    ['unsupported payment plan', async () => { await db.executor.updateTable('ai_subscription_credit_payments').set({ plan_slug: 'unapproved' }).execute(); }],
    ['excessive payment coverage', async () => { await db.executor.insertInto('ai_subscription_credit_payments').values(Array.from({ length: 33 }, (_, n) => ({ invoice_id: `overflow_${n}`, subscription_id: 'sub_approved', owner_id: identity.ownerId, plan_slug: 'matrix_starter', paid_from: anchor, paid_until: '2027-01-31T10:00:00.000Z', created_at: anchor }))).execute(); }],
    ['overlapping prior cycle', async () => { await db.executor.insertInto('ai_subscription_credit_cycles').values({ owner_id: identity.ownerId, runtime_slot: 'primary', subscription_id: 'sub_prior', cycle_start: '2026-01-01T00:00:00.000Z', cycle_end: '2026-02-15T00:00:00.000Z', entitlement_microusd: 5_000_000, legacy_offset_microusd: 0, updated_at: anchor }).execute(); }],
  ] as const)('fails closed without granting for %s', async (_name, prepare) => {
    await prepare(); expect(await issue()).toBe('ineligible'); expect(await entries()).toEqual([]);
  });
  it('does not grant when disabled, for a mismatched slot or during account deletion', async () => {
    expect(await issueConfiguredSubscriptionAiCredit({ db, repository: repo, identity, env: {}, now: clock })).toBe('disabled');
    expect(await issueConfiguredSubscriptionAiCredit({ db, repository: repo, identity: { ...identity, runtimeSlot: 'secondary' }, env, now: clock })).toBe('ineligible');
    const secret = 'd'.repeat(32), at = clock.toISOString();
    await db.executor.insertInto('account_deletion_jobs').values({ owner_hash: hashAccountDeletionOwner(identity.ownerId, secret), status: 'scheduled', due_at: at, next_attempt_at: at, created_at: at, updated_at: at }).execute();
    expect(await issueConfiguredSubscriptionAiCredit({ db, repository: repo, identity, env: { ...env, ACCOUNT_DELETION_SECRET: secret }, now: clock })).toBe('ineligible');
    expect(await entries()).toEqual([]);
  });
  it.each(['ambiguous', 'invalid', 'moved', 'legacy-valid', 'legacy-invalid'] as const)('reconciles historical starter attribution safely: %s', async kind => {
    const entryId = kind.startsWith('legacy') ? `${kind === 'legacy-valid' ? 'manual-main-chat-20261008-permanent-5usd' : 'invalid'}:fixture`
      : kind === 'invalid' ? 'bad-starter' : `starter-lifetime:${createHash('sha256').update(identity.ownerId).digest('hex')}`;
    await repo.grantCredit({ identity, entryId, kind: 'promotional_grant', amountMicrousd: 5_000_000,
      sourceReference: kind.startsWith('legacy') ? 'user-authorized-main-chat-20261008-permanent-5usd' : 'matrix-ai-lifetime-starter', expiresAt: null });
    if (kind === 'ambiguous') await repo.grantCredit({ identity, entryId: 'manual-main-chat-20261008-permanent-5usd:extra', kind: 'promotional_grant', amountMicrousd: 5_000_000, sourceReference: 'user-authorized-main-chat-20261008-permanent-5usd', expiresAt: null });
    if (kind === 'moved') await db.executor.updateTable('ai_funded_promotional_grant_balances').set({ runtime_slot: 'other' }).execute();
    if (kind !== 'legacy-valid') {
      await expect(issue()).rejects.toThrow(/starter credit/i);
      expect(await db.executor.selectFrom('ai_subscription_credit_cycles').selectAll().execute()).toEqual([]);
    } else {
      await issue();
      const cycle = await db.executor.selectFrom('ai_subscription_credit_cycles').selectAll().executeTakeFirstOrThrow();
      await shortenSubscriptionCreditCycle(db, cycle, cycle.cycle_end, anchor);
      await shortenSubscriptionCreditCycle(db, cycle, '2026-01-30T00:00:00.000Z', anchor);
      expect(await entries()).toHaveLength(1);
      expect(await repo.getFundingSummary(identity)).toMatchObject({ remainingBalanceMicrousd: 0 });
    }
  });
  it('rejects extension of recorded expiry and rolls back a failed entitlement compare-and-swap', async () => {
    await issue();
    await db.executor.updateTable('ai_subscription_credit_cycles').set({ cycle_end: '2026-02-15T00:00:00.000Z' }).execute();
    await expect(issue()).rejects.toThrow(/reconciliation/);
    await db.executor.deleteFrom('ai_subscription_credit_cycles').execute();
    await db.executor.deleteFrom('ai_funded_credit_ledger').execute();
    const failing = { grantCreditInTransaction: async (...args: Parameters<typeof repo.grantCreditInTransaction>) => {
      await repo.grantCreditInTransaction(...args);
      await args[0].executor.updateTable('ai_subscription_credit_cycles').set({ entitlement_microusd: 1 }).execute();
    } };
    await expect(issueConfiguredSubscriptionAiCredit({ db, repository: failing, identity, env, now: clock })).rejects.toThrow(/concurrently/);
    expect(await entries()).toEqual([]);
    expect(await db.executor.selectFrom('ai_subscription_credit_cycles').selectAll().execute()).toEqual([]);
  });
  it('does not issue from an unpaid active subscription, wrong owner, or disabled policy', async () => {
    await db.executor.deleteFrom('ai_subscription_credit_payments').execute();
    expect(await issue()).toBe('ineligible'); expect(await entries()).toEqual([]);
    await pay('matrix_starter');
    expect(await issueConfiguredSubscriptionAiCredit({ db, repository: repo, identity: { ...identity, ownerId: 'wrong_owner' }, env, now: clock })).toBe('ineligible');
    await repo.updateGlobalPolicy({ expectedRevision: 1, enabled: false, allowedModelIds: [] });
    expect(await issue()).toBe('ineligible'); expect(await entries()).toEqual([]);
  });
});
}

{
it('keeps subscription allowances disabled until explicitly activated', () => {
  expect(loadSubscriptionAiCreditPolicy({})).toEqual({ enabled: false });
  expect(loadSubscriptionAiCreditPolicy({ MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED: 'false',
    MATRIX_AI_SUBSCRIPTION_CREDIT_POLICY_JSON: '{arbitrary legacy input' })).toEqual({ enabled: false });
});
it('uses only the approved concrete tier amounts', () => {
  expect(loadSubscriptionAiCreditPolicy({ MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED: 'true' })).toEqual({
    enabled: true, amountsMicrousd: { matrix_starter: 5_000_000, matrix_builder: 10_000_000, matrix_max: 20_000_000 },
  });
});
it('fails closed if an operator tries to activate the obsolete arbitrary policy format', () => {
  expect(() => loadSubscriptionAiCreditPolicy({ MATRIX_AI_SUBSCRIPTION_CREDIT_ENABLED: 'true',
    MATRIX_AI_SUBSCRIPTION_CREDIT_POLICY_JSON: '{}' })).toThrow(/reviewed/);
});

it.each([
  ['2026-01-31T10:00:00.000Z', '2026-02-28T09:59:59.999Z', '2026-01-31T10:00:00.000Z', '2026-02-28T10:00:00.000Z'],
  ['2026-01-31T10:00:00.000Z', '2026-02-28T10:00:00.000Z', '2026-02-28T10:00:00.000Z', '2026-03-31T10:00:00.000Z'],
  ['2028-01-31T10:00:00.000Z', '2028-02-29T10:00:00.000Z', '2028-02-29T10:00:00.000Z', '2028-03-31T10:00:00.000Z'],
  ['2024-02-29T10:00:00.000Z', '2025-02-28T10:00:00.000Z', '2025-02-28T10:00:00.000Z', '2025-03-29T10:00:00.000Z'],
])('keeps the original anniversary after short months and leap years (%s, %s)', (anchor, now, start, end) => {
  expect(subscriptionCreditCycle(anchor, new Date(now))).toEqual({ start, end });
});
it('does not issue before the subscription anchor', () => {
  expect(subscriptionCreditCycle('2026-10-23T10:00:00.000Z', new Date('2026-10-22T10:00:00.000Z'))).toBeNull();
});
}
}

{
{
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
}

{
const main = '00000000-0000-4000-8000-000000000001';
const sibling = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
const env = { MATRIX_FUNDED_AI_ADDON_CHECKOUT_ENABLED: 'true', STRIPE_SECRET_KEY: 'fixture', STRIPE_WEBHOOK_SECRET: 'fixture',
  STRIPE_PRICE_AI_CREDIT_USD_5: 'price_fixture_5', STRIPE_PRICE_AI_CREDIT_USD_10: 'price_fixture_10', STRIPE_PRICE_AI_CREDIT_USD_25: 'price_fixture_25' };

describe('machine-scoped purchase configuration', () => {
  it.each(['[]', 'invalid json', '["not-a-uuid"]', JSON.stringify(Array(33).fill(main))])('fails closed for invalid configured list %s', value => {
    expect(loadAiCreditCheckoutConfig({ ...env, MATRIX_FUNDED_AI_ADDON_CHECKOUT_ALLOWED_MACHINE_IDS: value }).enabled).toBe(false);
  });
});

describe('machine-scoped checkout admission', () => {
  let db: PlatformDB;
  const model = '@cf/zai-org/glm-5.3-flash';
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  async function app() {
    const repository = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32) });
    await repository.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [model] });
    for (const [machineId, ownerId, runtimeSlot] of [[main, 'owner', 'primary'], [sibling, 'owner', 'second'], [other, 'other', 'primary']]) {
      await insertUserMachine(db, { machineId, clerkUserId: ownerId, runtimeSlot, handle: `qa-${machineId.slice(-2)}`, status: 'running', imageVersion: 'fixture', activationState: 'authorized', provisionedAt: new Date().toISOString() });
      await repository.setRuntimePolicy({ identity: { machineId, ownerId, runtimeSlot }, expectedRevision: 0, enabled: true, allowedModelIds: [model], monthlyBudgetMicrousd: 100000, expiresAt: null });
      await repository.grantCredit({ identity: { machineId, ownerId, runtimeSlot }, entryId: `grant-${machineId}`, kind: 'addon_grant', amountMicrousd: 100000, sourceReference: 'fixture' });
    }
    const config = loadAiCreditCheckoutConfig({ ...env, MATRIX_FUNDED_AI_ADDON_CHECKOUT_ALLOWED_MACHINE_IDS: JSON.stringify([main]) });
    const a = new Hono();
    a.post('/checkout', createAiCreditCheckoutHandler({ db, checkout: config, env: {}, now: () => new Date(),
      resolveClerkUserId: async c => c.req.header('x-fixture-owner') ?? 'owner', fundedAiRepository: repository,
      fundedModelProbes: { probe: async () => ({ ready: true, checkedAt: new Date().toISOString(), staleAfter: new Date(Date.now() + 60000).toISOString() }) },
      stripe: { apiTimeoutMs: 1000, createAiCreditCheckoutSession: async input => ({ id: `cs_fixture_${input.requestId.replaceAll('-', '')}`, url: 'https://checkout.stripe.com/c/pay/fixture' }) } as never,
      unavailableResponse: { code: 'billing_unavailable', error: 'Unavailable' } }));
    return { a, repository };
  }
  it('permits the configured main while denying the same owner sibling and another owner before creating a checkout', async () => {
    const { a } = await app();
    const request = (runtimeSlot: string, owner = 'owner') => a.request('/checkout', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-owner': owner }, body: JSON.stringify({ runtimeSlot, packageId: 'usd_5', requestId: randomUUID() }) });
    expect((await request('second')).status).toBe(503);
    expect((await request('primary', 'other')).status).toBe(503);
    expect(await db.executor.selectFrom('ai_credit_checkout_claims').selectAll().execute()).toEqual([]);
    expect((await request('primary')).status).toBe(200);
    expect(await db.executor.selectFrom('ai_credit_checkout_claims').select(['machine_id']).execute()).toEqual([{ machine_id: main }]);
  });
  it('advertises top-up only to the authenticated configured computer', async () => {
    const { repository } = await app();
    const platformSecret = 'p'.repeat(32);
    const a = new Hono().route('/internal/containers/:handle/ai', createAiFundedRuntimeRoutes({ db, repository,
      platformSecret, topUpEnabled: true, topUpAllowedMachineIds: [main] }));
    for (const [machineId, handle, runtimeSlot, want] of [[main, 'qa-01', 'primary', true], [sibling, 'qa-02', 'second', false], [other, 'qa-03', 'primary', false]] as const) {
      const token = buildPlatformRuntimeVerificationToken({ machineId, handle, runtimeSlot }, platformSecret);
      const response = await a.request(`/internal/containers/${handle}/ai/funding-summary?runtimeSlot=${runtimeSlot}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(200);
      expect((await response.json()).funding.topUpEnabled).toBe(want);
    }
  });
});
}
}
