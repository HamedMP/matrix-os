import { FundedAiSafeErrorSchema, MANAGED_WORKERS_AI_MODEL_IDS } from '@matrix-os/contracts';
import { createAiFundedRelayRoutes } from '../../packages/platform/src/ai-funded-policy-routes.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { initializeCustomerFundedStarterPolicy } from '../../packages/platform/src/customer-funded-starter-policy.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { FREE_MANAGED_MODEL_ID } from '../../packages/platform/src/free-tier/funded-policy.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createScopedPlatformDbs, freeTierPostgresUrl, type ScopedPlatformDbs } from './free-tier-postgres-helper.js';

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
  await insertUserMachine(db, {
    machineId, clerkUserId: `user_${kind}${index}`, handle: `${kind}${index}`, status: 'running', imageVersion: 'b1',
    provisionedAt: at.toISOString(), activationState: 'authorized',
    ...(kind === 'free' ? { substrate: 'container' as const, provisioningClass: 'free' as const } : {}),
  });
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
});

describe.skipIf(!freeTierPostgresUrl)('free funded policy races against real Postgres', () => {
  let scoped: ScopedPlatformDbs;
  beforeAll(async () => { scoped = await createScopedPlatformDbs('free_funded', 2); });
  afterAll(async () => { await scoped?.close(); });
  beforeEach(async () => {
    const [a] = scoped.pools as [PlatformDB];
    for (const table of ['ai_funded_reservation_promotional_allocations', 'ai_funded_usage_reservations', 'ai_funded_priority_claims',
      'ai_runtime_credentials', 'ai_funded_promotional_grant_balances', 'ai_funded_credit_ledger', 'ai_funded_runtime_balances',
      'ai_funded_runtime_policies', 'user_machines'] as const) {
      await a.executor.deleteFrom(table).execute();
    }
    await enableGlobalPolicy(a);
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
});
