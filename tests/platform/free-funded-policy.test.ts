import { FundedAiSafeErrorSchema, MANAGED_WORKERS_AI_MODEL_IDS } from '@matrix-os/contracts';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
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
 * credit plus a $5 allowance each UTC day, capped at $20 of allowance usage per
 * UTC month, on the managed GLM model only, under a global daily spend ceiling
 * answered as busy. Faults detected: a free owner reaching other models, an
 * allowance granted twice, kept past its day, or not reset at the month
 * boundary, allowance usage passing the monthly cap, free spend passing the
 * daily ceiling, a paid owner caught by free limits, and a lock-order deadlock
 * between a funding read and admission.
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

  it('adds $5 for the UTC day on top of the starter credit and admits up to exactly that much', async () => {
    const free = harness(db, 100 * USD, clock);
    const credential = await free.credential(await addRuntime(db, 1, 'free', NOV));
    await free.spend(credential, 6 * USD);
    await expect(free.authorize(credential, 4 * USD + 1)).rejects.toThrow();
    await free.spend(credential, 4 * USD);
    await expect(free.authorize(credential, 1)).rejects.toThrow();
    const grants = await db.executor.selectFrom('ai_funded_credit_ledger').select(['entry_id', 'amount_microusd'])
      .where('kind', '=', 'promotional_grant').orderBy('entry_id').execute();
    expect(grants.map((grant) => [grant.entry_id.split(':')[0], Number(grant.amount_microusd)]))
      .toEqual([['free-daily', 5 * USD], ['starter-lifetime', 5 * USD]]);
  });

  it('grants a new $5 each UTC day and retires the unused remainder when its day ends', async () => {
    const free = harness(db, 100 * USD, clock);
    const identity = await addRuntime(db, 1, 'free', NOV);
    // The expiring day's allowance is spent before the starter credit, which never expires.
    await free.spend(await free.credential(identity), 3 * USD);
    clock.now = new Date('2026-11-20T23:59:00.000Z');
    await free.spend(await free.credential(identity), USD);
    clock.now = new Date('2026-11-21T00:00:00.000Z');
    const nextDay = await free.credential(identity);
    // Yesterday's unspent $1 is gone: the untouched starter credit plus today's $5 remain.
    await expect(free.authorize(nextDay, 10 * USD + 1)).rejects.toThrow(refusal('insufficient_credit'));
    await expect(free.authorize(nextDay, 10 * USD)).resolves.toMatchObject({ reservation: { reservedMicrousd: 10 * USD } });
    const allowances = await db.executor.selectFrom('ai_funded_promotional_grant_balances')
      .select(['grant_entry_id', 'remaining_microusd', 'expires_at']).where('grant_entry_id', 'like', 'free-daily:%')
      .orderBy('grant_entry_id').execute();
    expect(allowances.map((row) => [row.grant_entry_id.slice(-10), Number(row.remaining_microusd), row.expires_at])).toEqual([
      ['2026-11-20', 0, '2026-11-21T00:00:00.000Z'],
      ['2026-11-21', 5 * USD, '2026-11-22T00:00:00.000Z'],
    ]);
    const expiry = await db.executor.selectFrom('ai_funded_credit_ledger').select('amount_microusd')
      .where('kind', '=', 'promotional_expiry').execute();
    expect(expiry.map((row) => Number(row.amount_microusd))).toEqual([-USD]);
  });

  it('caps a month\'s allowance usage at $20: the crossing day gets only the remainder, later days nothing, a new month resets', async () => {
    const free = harness(db, 100 * USD, clock);
    const identity = await addRuntime(db, 1, 'free', NOV);
    const at = (iso: string) => { clock.now = new Date(iso); };
    // Nov 20: the starter credit and the day's $5 are both spent.
    await free.spend(await free.credential(identity), 10 * USD);
    at('2026-11-21T12:00:00.000Z');
    await free.spend(await free.credential(identity), 5 * USD);
    // Nov 22: $1 is left unspent; Nov 23's admission retires it before granting the day.
    at('2026-11-22T12:00:00.000Z');
    await free.spend(await free.credential(identity), 4 * USD);
    // Nov 23: $3 settles, $1 is still held when the next day is granted, and $1 is left unspent.
    at('2026-11-23T12:00:00.000Z');
    await free.spend(await free.credential(identity), 3 * USD);
    at('2026-11-23T23:59:50.000Z');
    const late = await free.credential(identity);
    const held = await free.authorize(late, USD);
    const heldIds = { reservationId: held.reservation.reservationId, tokenId: late.tokenId };
    await free.repo.startReservation(heldIds);
    at('2026-11-24T00:00:00.000Z');
    // $5 + $5 + $4 + ($3 settled + $1 held) = $18 of allowance used, so Nov 24 gets $2. This
    // funding read grants before it retires Nov 23's unspent $1, which therefore must not count.
    await free.repo.getRuntimeFundingSummary(identity);
    await free.repo.settleReservation({ ...heldIds, actualCostMicrousd: USD });
    await free.spend(late, 2 * USD);
    // The runtime's monthly budget (starter plus the $20 cap) also runs out here; the grants below are the check.
    await expect(free.authorize(late, 1)).rejects.toThrow();
    at('2026-11-25T12:00:00.000Z');
    await expect(free.authorize(await free.credential(identity), 1)).rejects.toThrow();
    const daily = () => db.executor.selectFrom('ai_funded_credit_ledger').select(['entry_id', 'amount_microusd'])
      .where('entry_id', 'like', 'free-daily:%').orderBy('entry_id').execute();
    expect((await daily()).map((row) => [row.entry_id.slice(-10), Number(row.amount_microusd)])).toEqual([
      ['2026-11-20', 5 * USD], ['2026-11-21', 5 * USD], ['2026-11-22', 5 * USD], ['2026-11-23', 5 * USD], ['2026-11-24', 2 * USD],
    ]);
    at('2026-12-01T00:00:00.000Z');
    const december = await free.credential(identity);
    await expect(free.authorize(december, 5 * USD + 1)).rejects.toThrow(refusal('insufficient_credit'));
    await expect(free.authorize(december, 5 * USD)).resolves.toMatchObject({
      reservation: { reservedMicrousd: 5 * USD, periodStart: '2026-12-01T00:00:00.000Z' },
    });
    expect(Number((await daily()).at(-1)!.amount_microusd)).toBe(5 * USD);
    expect((await daily()).at(-1)!.entry_id.slice(-10)).toBe('2026-12-01');
  });

  it('creates one daily grant when an owner\'s first requests of a new UTC day arrive together', async () => {
    const free = harness(db, 100 * USD, clock);
    const identity = await addRuntime(db, 1, 'free', NOV);
    await free.spend(await free.credential(identity), 10 * USD);
    clock.now = new Date('2026-11-21T00:00:00.000Z');
    const credential = await free.credential(identity);
    const results = await Promise.allSettled([
      free.authorize(credential, 2 * USD), free.authorize(credential, 2 * USD), free.repo.getRuntimeFundingSummary(identity),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').select('entry_id')
      .where('entry_id', 'like', 'free-daily:%:2026-11-21').execute()).toHaveLength(1);
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
      .select(['machine_id', 'remaining_microusd']).where('grant_entry_id', 'like', 'free-daily:%').execute();
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
      .where('entry_id', 'like', 'free-daily:%').execute()).toHaveLength(1);
  });

  it('moves an unspent legacy monthly allowance to a replacement VM, still counting it toward the cap', async () => {
    const free = harness(db, 100 * USD, clock);
    const first = await addRuntime(db, 1, 'free', NOV);
    // A $5 monthly allowance granted this month, before daily allowances replaced it.
    const legacyId = `free-monthly:${createHash('sha256').update(first.ownerId).digest('hex')}:2026-11`;
    await free.repo.grantCredit({
      entryId: legacyId, identity: first, kind: 'promotional_grant', amountMicrousd: 5 * USD,
      sourceReference: 'matrix-free-monthly-allowance', expiresAt: '2026-12-01T00:00:00.000Z',
    });
    await db.executor.updateTable('user_machines').set({ status: 'deleted', deleted_at: NOV.toISOString() })
      .where('machine_id', '=', first.machineId).execute();
    const replacement = { ownerId: first.ownerId, machineId: 'free-1-replacement', runtimeSlot: 'primary' };
    await insertFreeMetalRuntime(db, { machineId: replacement.machineId, clerkUserId: first.ownerId, handle: 'free1r', at: NOV });
    await db.transaction((trx) => initializeCustomerFundedStarterPolicy(trx, replacement.machineId, { now: NOV.toISOString(), env: ENV }));

    const credential = await free.credential(replacement);
    // The legacy $5 moves with the owner, and today's $5 is granted beside it.
    await expect(free.authorize(credential, 10 * USD + 1)).rejects.toThrow(refusal('insufficient_credit'));
    await expect(free.authorize(credential, 10 * USD)).resolves.toBeDefined();
    const legacy = await db.executor.selectFrom('ai_funded_promotional_grant_balances').select(['machine_id', 'remaining_microusd'])
      .where('grant_entry_id', '=', legacyId).executeTakeFirstOrThrow();
    expect([legacy.machine_id, Number(legacy.remaining_microusd)]).toEqual([replacement.machineId, 5 * USD]);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').select('entry_id')
      .where('entry_id', '=', legacyId).execute()).toHaveLength(1);
  });

  it.each([
    { before: 5 * USD, after: 25 * USD }, { before: 10 * USD, after: 25 * USD }, { before: 7 * USD, after: 7 * USD },
  ])('raises an already-registered free runtime from an earlier default budget on its funding path ($before)', async ({ before, after }) => {
    const free = harness(db, 100 * USD, clock);
    const identity = await addRuntime(db, 1, 'free', NOV);
    const budget = () => db.executor.selectFrom('ai_funded_runtime_policies').select('monthly_budget_microusd')
      .where('machine_id', '=', identity.machineId).executeTakeFirstOrThrow().then((row) => Number(row.monthly_budget_microusd));
    await db.executor.updateTable('ai_funded_runtime_policies').set({ monthly_budget_microusd: before })
      .where('machine_id', '=', identity.machineId).execute();
    expect((await free.repo.getRuntimeFundingSummary(identity)).policy.monthlyBudgetMicrousd).toBe(after);
    expect(await budget()).toBe(after);
    // Admission applies the raise in the same request.
    await db.executor.updateTable('ai_funded_runtime_policies').set({ monthly_budget_microusd: before })
      .where('machine_id', '=', identity.machineId).execute();
    const admitted = free.authorize(await free.credential(identity), Math.min(before, 5 * USD) + 1);
    if (after > before) await expect(admitted).resolves.toMatchObject({ policy: { monthlyBudgetMicrousd: after } });
    else await expect(admitted).resolves.toBeDefined();
    expect(await budget()).toBe(after);
  });

  it('never raises a limit an operator saved, even one equal to an earlier default', async () => {
    const free = harness(db, 100 * USD, clock);
    const identity = await addRuntime(db, 1, 'free', NOV);
    const budget = () => db.executor.selectFrom('ai_funded_runtime_policies').select(['monthly_budget_microusd', 'revision'])
      .where('machine_id', '=', identity.machineId).executeTakeFirstOrThrow()
      .then((row) => ({ budget: Number(row.monthly_budget_microusd), revision: row.revision }));
    const save = async (monthlyBudgetMicrousd: number) => free.repo.setRuntimePolicy({
      identity, expectedRevision: (await budget()).revision, enabled: true, expiresAt: null,
      allowedModelIds: [FREE_MANAGED_MODEL_ID], monthlyBudgetMicrousd,
    });
    // An operator saves $10 after the rollout: funding reads, admission and re-registration keep it.
    await save(10 * USD);
    expect((await free.repo.getRuntimeFundingSummary(identity)).policy.monthlyBudgetMicrousd).toBe(10 * USD);
    await expect(free.authorize(await free.credential(identity), USD)).resolves.toMatchObject({ policy: { monthlyBudgetMicrousd: 10 * USD } });
    await db.transaction((trx) => initializeCustomerFundedStarterPolicy(trx, identity.machineId, { now: NOV.toISOString(), env: ENV }));
    expect((await budget()).budget).toBe(10 * USD);
  });

  it('respects an operator change made after a default budget was raised', async () => {
    const free = harness(db, 100 * USD, clock);
    const identity = await addRuntime(db, 1, 'free', NOV);
    await db.executor.updateTable('ai_funded_runtime_policies').set({ monthly_budget_microusd: 10 * USD })
      .where('machine_id', '=', identity.machineId).execute();
    const raised = await free.repo.getRuntimeFundingSummary(identity);
    expect(raised.policy.monthlyBudgetMicrousd).toBe(25 * USD);
    await free.repo.setRuntimePolicy({
      identity, expectedRevision: raised.policy.runtimeRevision, enabled: true, expiresAt: null,
      allowedModelIds: [FREE_MANAGED_MODEL_ID], monthlyBudgetMicrousd: 5 * USD,
    });
    expect((await free.repo.getRuntimeFundingSummary(identity)).policy.monthlyBudgetMicrousd).toBe(5 * USD);
    await expect(free.authorize(await free.credential(identity), USD)).resolves.toMatchObject({ policy: { monthlyBudgetMicrousd: 5 * USD } });
  });

  it('keeps a paid runtime\'s budget even when it equals an earlier free default', async () => {
    const free = harness(db, 100 * USD, clock);
    const paid = await addRuntime(db, 1, 'customer', NOV);
    await db.executor.updateTable('ai_funded_runtime_policies').set({ monthly_budget_microusd: 10 * USD })
      .where('machine_id', '=', paid.machineId).execute();
    expect((await free.repo.getRuntimeFundingSummary(paid)).policy.monthlyBudgetMicrousd).toBe(10 * USD);
  });

  it('grants no monthly allowance on a funding read while the free runtime is disabled', async () => {
    const free = harness(db, 100 * USD, clock);
    const identity = await addRuntime(db, 1, 'free', NOV);
    await db.executor.updateTable('ai_funded_runtime_policies').set({ enabled: false })
      .where('machine_id', '=', identity.machineId).execute();
    await free.repo.getRuntimeFundingSummary(identity);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').select('entry_id')
      .where('entry_id', 'like', 'free-daily:%').execute()).toEqual([]);
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

  it.each([
    { before: '2026-11-20T23:59:59.900Z', after: '2026-11-21T00:00:00.100Z', periodStart: '2026-11-01T00:00:00.000Z' },
    { before: '2026-11-30T23:59:59.900Z', after: '2026-12-01T00:00:00.100Z', periodStart: '2026-12-01T00:00:00.000Z' },
  ])('refuses as busy, for a retry on the new day\'s allowance, an authorization that waited across midnight ($after)', async ({ before, after, periodStart }) => {
    const [a, b] = scoped.pools as [PlatformDB, PlatformDB];
    const clock = { now: new Date(before) };
    const free = harness(b, USD, clock);
    const first = await free.credential(await addRuntime(a, 200, 'free', NOV));
    const second = await free.credential(await addRuntime(a, 201, 'free', NOV));
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let gotLock!: (pid: number) => void;
    const locked = new Promise<number>((resolve) => { gotLock = resolve; });
    const blocker = a.transaction(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended('matrix:free-tier:daily-funded-spend', 0))`.execute(trx.executor);
      const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx.executor);
      gotLock(rows[0]!.pid);
      await hold;
    });
    const pid = await locked;
    const authorization = Promise.allSettled([free.authorize(first, USD)]);
    try {
      await vi.waitFor(async () => {
        const { rows } = await sql`SELECT pid FROM pg_locks WHERE NOT granted AND ${pid} = ANY(pg_blocking_pids(pid))`.execute(a.executor);
        expect(rows.length).toBeGreaterThan(0);
      }, { timeout: 3000 });
      clock.now = new Date(after);
    } finally {
      release();
      await blocker;
    }
    const [result] = await authorization;
    // The hold would draw on the day's allowance that just expired.
    expect(result).toMatchObject({ status: 'rejected', reason: { code: 'busy' } });
    await expect(free.authorize(first, USD)).resolves.toMatchObject({ reservation: { periodStart } });
    const reservation = await a.executor.selectFrom('ai_funded_usage_reservations').select('created_at')
      .where('machine_id', '=', 'free-200').executeTakeFirstOrThrow();
    expect(reservation.created_at).toBe(after);
    await expect(free.authorize(second, USD)).rejects.toThrow(refusal('busy'));
  });

  it('creates one daily grant when an owner\'s first requests of a new UTC day race across connections', async () => {
    const [a, b] = scoped.pools as [PlatformDB, PlatformDB];
    const clock = { now: NOV };
    const apps = [harness(a, 100 * USD, clock), harness(b, 100 * USD, clock)];
    const identity = await addRuntime(a, 300, 'free', NOV);
    await apps[0]!.spend(await apps[0]!.credential(identity), 10 * USD);
    clock.now = new Date('2026-11-21T00:00:00.000Z');
    const credential = await apps[0]!.credential(identity);
    const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => index % 3 === 2
      ? apps[index % 2]!.repo.getRuntimeFundingSummary(identity)
      : apps[index % 2]!.authorize(credential, USD)));
    for (const result of results) {
      if (result.status === 'rejected') expect(result.reason).toBeInstanceOf(AiFundedPolicyError);
    }
    const grants = await a.executor.selectFrom('ai_funded_credit_ledger').select('amount_microusd')
      .where('entry_id', 'like', 'free-daily:%:2026-11-21').execute();
    expect(grants.map((row) => Number(row.amount_microusd))).toEqual([5 * USD]);
    const balance = await a.executor.selectFrom('ai_funded_runtime_balances').selectAll()
      .where('machine_id', '=', identity.machineId).executeTakeFirstOrThrow();
    expect(Number(balance.reserved_microusd)).toBeLessThanOrEqual(5 * USD);
  });

  it('holds the monthly cap when settlements race the next day\'s grant', async () => {
    const [a, b] = scoped.pools as [PlatformDB, PlatformDB];
    const clock = { now: NOV };
    const apps = [harness(a, 100 * USD, clock), harness(b, 100 * USD, clock)];
    const identity = await addRuntime(a, 301, 'free', NOV);
    await apps[0]!.spend(await apps[0]!.credential(identity), 10 * USD);
    for (const day of ['21', '22']) {
      clock.now = new Date(`2026-11-${day}T12:00:00.000Z`);
      await apps[0]!.spend(await apps[0]!.credential(identity), 5 * USD);
    }
    clock.now = new Date('2026-11-23T23:59:50.000Z');
    const late = await apps[0]!.credential(identity);
    const holds = [];
    for (let index = 0; index < 4; index += 1) {
      const held = await apps[0]!.authorize(late, USD);
      const ids = { reservationId: held.reservation.reservationId, tokenId: late.tokenId };
      await apps[0]!.repo.startReservation(ids);
      holds.push(ids);
    }
    clock.now = new Date('2026-11-24T00:00:00.000Z');
    // $15 used and $4 held: settlements race the funding read that grants Nov 24.
    await Promise.all([
      ...holds.map((ids, index) => apps[index % 2]!.repo.settleReservation({ ...ids, actualCostMicrousd: USD })),
      apps[1]!.repo.getRuntimeFundingSummary(identity),
    ]);
    const grants = await a.executor.selectFrom('ai_funded_credit_ledger').select('amount_microusd')
      .where('entry_id', 'like', 'free-daily:%:2026-11-24').execute();
    expect(grants.map((row) => Number(row.amount_microusd))).toEqual([USD]);
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
