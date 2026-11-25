import { FundedAiSafeErrorSchema, MANAGED_WORKERS_AI_MODEL_IDS } from '@matrix-os/contracts';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { createAiFundedRelayRoutes, createAiFundedRuntimeRoutes } from '../../packages/platform/src/ai-funded-policy-routes.js';
import { buildPlatformRuntimeVerificationToken } from '../../packages/platform/src/platform-token.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiFundedPolicyError } from '../../packages/platform/src/ai-funded-policy-errors.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { initializeCustomerFundedStarterPolicy } from '../../packages/platform/src/customer-funded-starter-policy.js';
import { insertUserMachine, upsertBillingEntitlement, type PlatformDB } from '../../packages/platform/src/db.js';
import { buildFreeEntitlement } from '../../packages/platform/src/free-tier/free-entitlement.js';
import { FREE_MANAGED_MODEL_ID } from '../../packages/platform/src/free-tier/funded-policy.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createScopedPlatformDbs, freeTierPostgresUrl, type ScopedPlatformDbs } from './free-tier-postgres-helper.js';
import { insertFreeMetalRuntime } from './free-funded-test-helper.js';

/**
 * Free Matrix AI on metal (spec 2691, ENG-520 Task P7; ported from PR #3437,
 * container fixtures swapped for metal). A free runtime pays from the starter
 * credit plus a $5 allowance each UTC month, on the managed GLM model only,
 * under a global daily spend ceiling answered as busy. Faults detected: a free
 * owner reaching other models, an allowance granted twice or not reset at the
 * month boundary, free spend passing the daily ceiling, a paid owner caught by
 * free limits, and a lock-order deadlock between a funding read and admission.
 */

const NOV = new Date('2026-11-20T12:00:00.000Z');
const MODELS = ['anthropic/claude-sonnet-5', ...MANAGED_WORKERS_AI_MODEL_IDS];
const ENV = {
  MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: 'true', MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'true',
  AI_FUNDED_CREDENTIAL_HASH_SECRET: 'h'.repeat(32),
};
const USD = 1_000_000;
const RELAY_TOKEN = 'r'.repeat(40);
let sequence = 0;

async function enableGlobalPolicy(db: PlatformDB) {
  await db.executor.updateTable('ai_funded_global_policy')
    .set({ enabled: true, allowed_model_ids: JSON.stringify(MODELS), revision: 1 })
    .where('policy_id', '=', 'default').execute();
}

async function addRuntime(db: PlatformDB, index: number, kind: 'free' | 'customer', at: Date) {
  const machineId = `${kind}-${index}`;
  if (kind === 'free') {
    await insertFreeMetalRuntime(db, { machineId, clerkUserId: `user_${kind}${index}`, handle: `${kind}${index}`, at });
  } else {
    await insertUserMachine(db, {
      machineId, clerkUserId: `user_${kind}${index}`, handle: `${kind}${index}`, status: 'running', imageVersion: 'b1',
      provisionedAt: at.toISOString(), activationState: 'authorized',
    });
  }
  await db.transaction((trx) => initializeCustomerFundedStarterPolicy(trx, machineId, { now: at.toISOString(), env: ENV }));
  return { ownerId: `user_${kind}${index}`, machineId, runtimeSlot: 'primary' };
}

function harness(db: PlatformDB, dailyFundedSpendMicrousd: number | undefined, clock: { now: Date }) {
  const repo = createAiFundedPolicyRepository({
    db, credentialHashSecret: 'h'.repeat(32), now: () => clock.now,
    freeFunding: dailyFundedSpendMicrousd === undefined ? {} : { dailyFundedSpendMicrousd },
  });
  return {
    repo,
    async credential(identity: { ownerId: string; machineId: string; runtimeSlot: string }) {
      return (await repo.issueRuntimeCredential(identity)).credential;
    },
    authorize(credential: { token: string }, maxCostMicrousd: number, modelId = FREE_MANAGED_MODEL_ID) {
      sequence += 1;
      return repo.authorize({ credential: credential.token, requestId: `request_${sequence}`, modelId, maxCostMicrousd });
    },
    async spend(credential: { token: string; tokenId: string }, amount: number) {
      const authorized = await this.authorize(credential, amount);
      const ids = { reservationId: authorized.reservation.reservationId, tokenId: credential.tokenId };
      await repo.startReservation(ids);
      await repo.settleReservation({ ...ids, actualCostMicrousd: amount });
    },
  };
}

const refusal = (code: string) => expect.objectContaining({ code });

describe('free funded policy', () => {
  let db: PlatformDB;
  const clock = { now: NOV };
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    clock.now = NOV;
    await enableGlobalPolicy(db);
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it('admits only the managed default model for a free runtime', async () => {
    const free = harness(db, 100 * USD, clock);
    const credential = await free.credential(await addRuntime(db, 1, 'free', NOV));
    await expect(free.authorize(credential, USD, '@cf/zai-org/glm-5.3')).rejects.toThrow(refusal('model_not_allowed'));
    await expect(free.authorize(credential, USD)).resolves.toMatchObject({ reservation: { reservedMicrousd: USD } });
  });

  it('adds $5 each month on top of the starter credit and admits up to exactly that much', async () => {
    const free = harness(db, 100 * USD, clock);
    const credential = await free.credential(await addRuntime(db, 1, 'free', NOV));
    await free.spend(credential, 6 * USD);
    await expect(free.authorize(credential, 4 * USD + 1)).rejects.toThrow();
    await free.spend(credential, 4 * USD);
    await expect(free.authorize(credential, 1)).rejects.toThrow();
    const grants = await db.executor.selectFrom('ai_funded_credit_ledger').select(['entry_id', 'amount_microusd'])
      .where('kind', '=', 'promotional_grant').orderBy('entry_id').execute();
    expect(grants.map((grant) => [grant.entry_id.split(':')[0], Number(grant.amount_microusd)]))
      .toEqual([['free-monthly', 5 * USD], ['starter-lifetime', 5 * USD]]);
  });

  it('starts a new $5 allowance at the UTC month boundary and retires last month\'s remainder', async () => {
    const free = harness(db, 100 * USD, clock);
    const identity = await addRuntime(db, 1, 'free', NOV);
    const credential = await free.credential(identity);
    await free.spend(credential, 3 * USD);
    clock.now = new Date('2026-11-30T23:59:00.000Z');
    await free.spend(await free.credential(identity), USD);
    clock.now = new Date('2026-12-01T00:00:00.000Z');
    const december = await free.credential(identity);
    await expect(free.authorize(december, 10 * USD + 1)).rejects.toThrow();
    await expect(free.authorize(december, 10 * USD)).resolves.toMatchObject({ reservation: { reservedMicrousd: 10 * USD } });
    const allowances = await db.executor.selectFrom('ai_funded_promotional_grant_balances')
      .select(['grant_entry_id', 'remaining_microusd']).where('grant_entry_id', 'like', 'free-monthly:%')
      .orderBy('grant_entry_id').execute();
    expect(allowances.map((row) => [row.grant_entry_id.slice(-7), Number(row.remaining_microusd)]))
      .toEqual([['2026-11', 0], ['2026-12', 5 * USD]]);
  });

  it('refuses new free funded work as busy over the daily ceiling, and admits again the next UTC day', async () => {
    const free = harness(db, 3 * USD, clock);
    const a = await free.credential(await addRuntime(db, 1, 'free', NOV));
    const b = await free.credential(await addRuntime(db, 2, 'free', NOV));
    await free.spend(a, 2 * USD);
    await expect(free.authorize(b, USD + 1)).rejects.toThrow(expect.objectContaining({
      code: 'busy', retry: { at: '2026-11-21T00:00:00.000Z', afterSeconds: 12 * 3600 },
    }));
    await expect(free.authorize(b, USD)).resolves.toBeDefined();
    clock.now = new Date('2026-11-21T00:00:00.000Z');
    const c = await free.credential(await addRuntime(db, 3, 'free', clock.now));
    await expect(free.authorize(c, 3 * USD)).resolves.toBeDefined();
  });

  it('refuses a small customer hold when its maximum provider cost exceeds the free daily ceiling', async () => {
    const free = harness(db, 10, clock);
    const identity = await addRuntime(db, 1, 'free', NOV);
    await db.executor.updateTable('ai_funded_runtime_policies').set({ monthly_budget_microusd: 10 })
      .where('machine_id', '=', identity.machineId).execute();
    const credential = await free.credential(identity);
    await expect(free.repo.authorize({
      credential: credential.token, requestId: 'max_exceeds_daily', modelId: FREE_MANAGED_MODEL_ID,
      maxCostMicrousd: 24, billingMode: 'usage',
    })).rejects.toThrow(refusal('busy'));
  });

  it('counts a pending request at its maximum provider cost across free owners', async () => {
    const free = harness(db, 50, clock);
    const identity = await addRuntime(db, 1, 'free', NOV);
    await db.executor.updateTable('ai_funded_runtime_policies').set({ monthly_budget_microusd: 10 })
      .where('machine_id', '=', identity.machineId).execute();
    const a = await free.credential(identity);
    const b = await free.credential(await addRuntime(db, 2, 'free', NOV));
    await expect(free.repo.authorize({
      credential: a.token, requestId: 'max_to_reserve', modelId: FREE_MANAGED_MODEL_ID,
      maxCostMicrousd: 40, billingMode: 'usage',
    })).resolves.toMatchObject({ reservation: { reservedMicrousd: 10, maxCostMicrousd: 40 } });
    await expect(free.authorize(b, 11)).rejects.toThrow(refusal('busy'));
    await expect(free.authorize(b, 10)).resolves.toBeDefined();
  });

  it('answers the relay with 503, a Retry-After until UTC midnight, and a busy body over the daily ceiling', async () => {
    const free = harness(db, USD, clock);
    const a = await free.credential(await addRuntime(db, 1, 'free', NOV));
    await free.spend(a, USD);
    const routes = createAiFundedRelayRoutes({ relayControlToken: RELAY_TOKEN, repository: free.repo });
    const response = await routes.request('/authorize', {
      method: 'POST',
      headers: { authorization: `Bearer ${RELAY_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ credential: a.token, requestId: 'request_busy', modelId: FREE_MANAGED_MODEL_ID, maxCostMicrousd: 1 }),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe(String(12 * 3600));
    const body = FundedAiSafeErrorSchema.parse(await response.json());
    expect(body).toEqual({ error: { code: 'busy', message: 'Matrix AI is busy; try again later', retryAt: '2026-11-21T00:00:00.000Z' } });
  });

  it('shows a free owner their Matrix AI funding and the managed model through the runtime routes', async () => {
    const free = harness(db, 100 * USD, clock);
    const identity = await addRuntime(db, 1, 'free', NOV);
    const secret = 'p'.repeat(48);
    const app = new Hono().route('/vps/:handle/ai',
      createAiFundedRuntimeRoutes({ db, platformSecret: secret, repository: free.repo, now: () => clock.now }));
    const call = (path: string, body: unknown) => app.request(`/vps/free1/ai/${path}?runtimeSlot=primary`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${buildPlatformRuntimeVerificationToken({ handle: 'free1', machineId: identity.machineId, runtimeSlot: 'primary' }, secret)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const summary = await call('funding-summary', {});
    expect(summary.status).toBe(200);
    const parsed = await summary.json() as { funding: { creditBalanceMicrousd: number }; policy: { enabled: boolean; allowedModelIds: string[] } };
    expect(parsed.policy).toMatchObject({ enabled: true, allowedModelIds: [FREE_MANAGED_MODEL_ID] });
    // The starter credit plus this month's allowance.
    expect(parsed.funding.creditBalanceMicrousd).toBe(10 * USD);
    const readiness = await call('route-readiness', {});
    expect(readiness.status).toBe(200);
    expect(await free.repo.getCheckoutFundingSummary(identity, Date.now() + 5_000))
      .toMatchObject({ policy: { enabled: true, allowedModelIds: [FREE_MANAGED_MODEL_ID] } });
  });

  it('answers a free runtime that asks for credentials too often as rate limited, not disabled', async () => {
    const free = harness(db, USD, clock);
    const identity = await addRuntime(db, 1, 'free', NOV);
    await free.credential(identity);
    await expect(free.credential(identity)).rejects.toThrow(refusal('rate_limited'));
  });

  it('refuses all free funded work when no daily ceiling is configured', async () => {
    const free = harness(db, undefined, clock);
    const credential = await free.credential(await addRuntime(db, 1, 'free', NOV));
    await expect(free.authorize(credential, 1)).rejects.toThrow(refusal('unavailable'));
  });

  // ENG-520 P7 fix round 1: readiness must match admission when no daily ceiling is configured.
  it('reports a free runtime as not ready when no daily ceiling is configured', async () => {
    const free = harness(db, undefined, clock);
    const identity = await addRuntime(db, 1, 'free', NOV);
    const summary = await free.repo.getRuntimeFundingSummary(identity, { includeChatAvailability: true });
    expect(summary.policy).toMatchObject({ enabled: false, allowedModelIds: [] });
    expect(summary.chatAvailability).toMatchObject({ eligibleBalanceMicrousd: 0, availableBalanceMicrousd: 0 });
    const checkout = await free.repo.getCheckoutFundingSummary(identity, Date.now() + 5_000, { includeChatAvailability: true });
    expect(checkout.policy).toMatchObject({ enabled: false, allowedModelIds: [] });
    expect(checkout.chatAvailability).toMatchObject({ eligibleBalanceMicrousd: 0, availableBalanceMicrousd: 0 });
    // A paid runtime is unaffected by the free ceiling setting.
    const paid = await addRuntime(db, 1, 'customer', NOV);
    expect((await free.repo.getRuntimeFundingSummary(paid)).policy.enabled).toBe(true);
  });

  it('moves the month\'s unspent allowance to a replacement VM without granting another', async () => {
    const free = harness(db, 100 * USD, clock);
    const first = await addRuntime(db, 1, 'free', NOV);
    await free.spend(await free.credential(first), 2 * USD);
    const allowance = () => db.executor.selectFrom('ai_funded_promotional_grant_balances')
      .select(['machine_id', 'remaining_microusd']).where('grant_entry_id', 'like', 'free-monthly:%').execute();
    const [before] = await allowance();
    const unspent = Number(before!.remaining_microusd);
    expect(unspent).toBeGreaterThan(0);
    // An operator deletes the VM; the owner builds a replacement the same month.
    await db.executor.updateTable('user_machines').set({ status: 'deleted', deleted_at: NOV.toISOString() })
      .where('machine_id', '=', first.machineId).execute();
    const replacement = { ownerId: first.ownerId, machineId: 'free-1-replacement', runtimeSlot: 'primary' };
    await insertFreeMetalRuntime(db, { machineId: replacement.machineId, clerkUserId: first.ownerId, handle: 'free1r', at: NOV });
    await db.transaction((trx) => initializeCustomerFundedStarterPolicy(trx, replacement.machineId, { now: NOV.toISOString(), env: ENV }));

    const credential = await free.credential(replacement);
    await expect(free.authorize(credential, unspent + 1)).rejects.toThrow();
    await expect(free.authorize(credential, unspent)).resolves.toMatchObject({ reservation: { reservedMicrousd: unspent } });
    expect((await allowance()).map((row) => [row.machine_id, Number(row.remaining_microusd)]))
      .toEqual([[replacement.machineId, unspent]]);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').select('entry_id')
      .where('entry_id', 'like', 'free-monthly:%').execute()).toHaveLength(1);
  });

  it('grants no monthly allowance on a funding read while the free runtime is disabled', async () => {
    const free = harness(db, 100 * USD, clock);
    const identity = await addRuntime(db, 1, 'free', NOV);
    await db.executor.updateTable('ai_funded_runtime_policies').set({ enabled: false })
      .where('machine_id', '=', identity.machineId).execute();
    await free.repo.getRuntimeFundingSummary(identity);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').select('entry_id')
      .where('entry_id', 'like', 'free-monthly:%').execute()).toEqual([]);
  });

  it('never applies the free ceiling, allowance, or model limit to a paid owner', async () => {
    const free = harness(db, USD, clock);
    const freeCredential = await free.credential(await addRuntime(db, 1, 'free', NOV));
    await free.spend(freeCredential, USD);
    const paid = await free.credential(await addRuntime(db, 1, 'customer', NOV));
    await expect(free.authorize(paid, 2 * USD, '@cf/zai-org/glm-5.3')).resolves.toBeDefined();
    const ledger = await db.executor.selectFrom('ai_funded_credit_ledger').select('entry_id')
      .where('owner_id', '=', 'user_customer1').execute();
    expect(ledger.map((row) => row.entry_id.split(':')[0])).toEqual(['starter-lifetime']);
  });

  it.each([false, true])('restores paid models after upgrade unless the operator restricted them (restricted: %s)', async (restricted) => {
    const free = harness(db, USD, clock);
    const identity = await addRuntime(db, 1, 'free', NOV);
    const paidModel = 'anthropic/claude-sonnet-5';
    if (restricted) {
      await free.repo.setRuntimePolicy({
        identity, expectedRevision: 1, enabled: true, expiresAt: null,
        allowedModelIds: [FREE_MANAGED_MODEL_ID], monthlyBudgetMicrousd: 42_000,
      });
    }
    const credential = await free.credential(identity);
    await expect(free.authorize(credential, 1, paidModel)).rejects.toThrow(refusal('model_not_allowed'));
    await upsertBillingEntitlement(db, {
      ...buildFreeEntitlement(identity.ownerId, NOV), source: 'stripe', planSlug: 'matrix_starter',
      status: 'active', stripeSubscriptionId: 'sub_upgraded',
    });
    const summary = await free.repo.getRuntimeFundingSummary(identity);
    if (restricted) {
      expect(summary.policy.allowedModelIds).toEqual([FREE_MANAGED_MODEL_ID]);
      await expect(free.authorize(credential, 1, paidModel)).rejects.toThrow(refusal('model_not_allowed'));
    } else {
      expect(summary.policy.allowedModelIds).toContain(paidModel);
      await expect(free.authorize(credential, 1, paidModel)).resolves.toBeDefined();
    }
  });

  it('funds a metal runtime whose owner holds no free entitlement as paid', async () => {
    const free = harness(db, USD, clock);
    await insertFreeMetalRuntime(db, { machineId: 'metal-paid', clerkUserId: 'user_metalpaid', handle: 'metalpaid', at: NOV, freeEntitlement: false });
    await db.transaction((trx) => initializeCustomerFundedStarterPolicy(trx, 'metal-paid', { now: NOV.toISOString(), env: ENV }));
    const credential = await free.credential({ ownerId: 'user_metalpaid', machineId: 'metal-paid', runtimeSlot: 'primary' });
    await expect(free.authorize(credential, 2 * USD, '@cf/zai-org/glm-5.3')).resolves.toBeDefined();
    const ledger = await db.executor.selectFrom('ai_funded_credit_ledger').select('entry_id')
      .where('owner_id', '=', 'user_metalpaid').execute();
    expect(ledger.map((row) => row.entry_id.split(':')[0])).toEqual(['starter-lifetime']);
  });
});

describe.skipIf(!freeTierPostgresUrl)('free funded policy races against real Postgres', () => {
  let scoped: ScopedPlatformDbs;
  beforeAll(async () => { scoped = await createScopedPlatformDbs('free_funded', 2); });
  afterAll(async () => { await scoped?.close(); });
  beforeEach(async () => {
    const [a] = scoped.pools as [PlatformDB];
    for (const table of ['ai_funded_reservation_promotional_allocations', 'ai_funded_usage_reservations', 'ai_funded_priority_claims',
      'ai_runtime_credentials', 'ai_funded_promotional_grant_balances', 'ai_funded_credit_ledger', 'ai_funded_runtime_balances',
      'ai_funded_runtime_policies', 'user_machines', 'billing_entitlements'] as const) {
      await a.executor.deleteFrom(table).execute();
    }
    await enableGlobalPolicy(a);
  });

  it('takes the owner locks in admission order when a funding read grants the monthly allowance', async () => {
    const [a, b] = scoped.pools as [PlatformDB, PlatformDB];
    const clock = { now: NOV };
    const identity = await addRuntime(a, 90, 'free', NOV);
    const free = harness(b, 3 * USD, clock);
    // Admission holds the billing owner lock and then wants the funded owner lock.
    let release!: () => void;
    const holding = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const billingHeld = new Promise<void>((resolve) => { locked = resolve; });
    const admission = a.transaction(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-owner:${identity.ownerId}`}, 0))`.execute(trx.executor);
      locked();
      await holding;
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`funded-ai-owner:${identity.ownerId}`}, 0))`.execute(trx.executor);
    });
    await billingHeld;
    const summary = free.repo.getRuntimeFundingSummary(identity);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    const [admitted, read] = await Promise.allSettled([admission, summary]);
    expect(admitted.status).toBe('fulfilled');
    expect(read.status).toBe('fulfilled');
  });

  it('admits free owners racing at the daily ceiling only up to the ceiling', async () => {
    const [a, b] = scoped.pools as [PlatformDB, PlatformDB];
    const clock = { now: NOV };
    const apps = [harness(a, 3 * USD, clock), harness(b, 3 * USD, clock)];
    const credentials = [];
    for (let index = 0; index < 10; index += 1) credentials.push(await apps[0]!.credential(await addRuntime(a, index, 'free', NOV)));
    const results = await Promise.allSettled(credentials.map((credential, index) => apps[index % 2]!.authorize(credential, USD)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3);
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'busy' });
    }
  });

  it('never reserves more than the month allows when one owner races itself', async () => {
    const [a, b] = scoped.pools as [PlatformDB, PlatformDB];
    const clock = { now: NOV };
    const apps = [harness(a, 100 * USD, clock), harness(b, 100 * USD, clock)];
    const credential = await apps[0]!.credential(await addRuntime(a, 1, 'free', NOV));
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => apps[index % 2]!.authorize(credential, 6 * USD)));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const balance = await a.executor.selectFrom('ai_funded_runtime_balances').selectAll().executeTakeFirstOrThrow();
    expect(Number(balance.month_reserved_microusd)).toBe(6 * USD);
    expect(Number(balance.credit_balance_microusd)).toBe(10 * USD);
    expect(await a.executor.selectFrom('ai_funded_credit_ledger').select('entry_id').execute()).toHaveLength(2);
  });

  // ENG-520 P7 fix round 1: with account deletion configured, admission takes the deletion fence. A free
  // authorize that grants the monthly allowance must take it exclusively up front; upgrading a shared fence
  // under the billing owner lock deadlocks two admissions for one owner.
  it('never deadlocks when one owner races itself with account deletion configured', async () => {
    vi.stubEnv('ACCOUNT_DELETION_SECRET', 'd'.repeat(40));
    try {
      const [a, b] = scoped.pools as [PlatformDB, PlatformDB];
      const clock = { now: NOV };
      const apps = [harness(a, 100 * USD, clock), harness(b, 100 * USD, clock)];
      const credential = await apps[0]!.credential(await addRuntime(a, 2, 'free', NOV));
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => apps[index % 2]!.authorize(credential, 6 * USD)));
      // Every refusal is a policy answer; a deadlock surfaces as a raw database error.
      for (const result of results) {
        if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(AiFundedPolicyError);
      }
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await a.executor.selectFrom('ai_funded_credit_ledger').select('entry_id')
        .where('owner_id', '=', 'user_free2').execute()).toHaveLength(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
