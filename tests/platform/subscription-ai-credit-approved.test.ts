import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { issueConfiguredSubscriptionAiCredit, loadSubscriptionAiCreditPolicy } from '../../packages/platform/src/subscription-ai-credit-policy.js';
import { createPlatformDb, insertUserMachine, upsertBillingCustomer, upsertBillingSubscription, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

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
  it('does not issue from an unpaid active subscription, wrong owner, or disabled policy', async () => {
    await db.executor.deleteFrom('ai_subscription_credit_payments').execute();
    expect(await issue()).toBe('ineligible'); expect(await entries()).toEqual([]);
    await pay('matrix_starter');
    expect(await issueConfiguredSubscriptionAiCredit({ db, repository: repo, identity: { ...identity, ownerId: 'wrong_owner' }, env, now: clock })).toBe('ineligible');
    await repo.updateGlobalPolicy({ expectedRevision: 1, enabled: false, allowedModelIds: [] });
    expect(await issue()).toBe('ineligible'); expect(await entries()).toEqual([]);
  });
});
