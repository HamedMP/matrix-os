import { createHash } from 'node:crypto';
import { MANAGED_WORKERS_AI_MODEL_IDS } from '@matrix-os/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import {
  createContainerRegistrationFunding,
  initializeCustomerFundedStarterPolicy,
} from '../../packages/platform/src/customer-funded-starter-policy.js';
import { buildPlatformContainerRuntimeToken } from '../../packages/platform/src/platform-token.js';
import { createContainerInternalRoutes } from '../../packages/platform/src/substrates/container-internal-routes.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createScopedPlatformDbs, freeTierPostgresUrl, type ScopedPlatformDbs } from './free-tier-postgres-helper.js';

const NOW = '2026-11-11T12:00:00.000Z';
const OWNER = 'user_freeowner';
const CONTAINER = 'ctr-free-1';
const MODELS = ['anthropic/claude-sonnet-5', ...MANAGED_WORKERS_AI_MODEL_IDS];
const ENV = {
  MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: 'true', MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'true',
  AI_FUNDED_CREDENTIAL_HASH_SECRET: 'h'.repeat(32),
};
const STARTER_ENTRY = `starter-lifetime:${createHash('sha256').update(OWNER).digest('hex')}`;

async function seed(db: PlatformDB, status = 'running') {
  await db.executor.updateTable('ai_funded_global_policy')
    .set({ enabled: true, allowed_model_ids: JSON.stringify(MODELS), revision: 1 })
    .where('policy_id', '=', 'default').execute();
  await insertUserMachine(db, {
    machineId: CONTAINER, clerkUserId: OWNER, handle: 'freeowner', status, imageVersion: 'b1',
    provisionedAt: NOW, substrate: 'container', activationState: 'authorized',
  });
}

const initialize = (db: PlatformDB, machineId = CONTAINER) => db.transaction((trx) =>
  initializeCustomerFundedStarterPolicy(trx, machineId, { now: NOW, env: ENV }));

describe('funded AI for a free container runtime', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it('creates a policy limited to managed models, a balance, and the once-per-owner starter credit', async () => {
    await seed(db);
    expect(await initialize(db)).toBe(true);
    const policy = await db.executor.selectFrom('ai_funded_runtime_policies').selectAll().executeTakeFirstOrThrow();
    expect(policy).toMatchObject({ machine_id: CONTAINER, owner_id: OWNER, runtime_slot: 'primary', enabled: true });
    expect(JSON.parse(policy.allowed_model_ids)).toEqual(['@cf/zai-org/glm-5.3-flash']);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').select(['entry_id', 'amount_microusd']).execute())
      .toEqual([{ entry_id: STARTER_ENTRY, amount_microusd: 5_000_000 }]);
    expect(await db.executor.selectFrom('ai_funded_runtime_balances').select('credit_balance_microusd').executeTakeFirst())
      .toEqual({ credit_balance_microusd: 5_000_000 });
  });

  it('issues a runtime credential for the free class', async () => {
    await seed(db);
    await initialize(db);
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => new Date(NOW) });
    const issued = await repo.issueRuntimeCredential({ ownerId: OWNER, machineId: CONTAINER, runtimeSlot: 'primary' });
    expect(issued.credential.token).toEqual(expect.any(String));
  });

  it('does not repeat starter credit for an owner who already received it on another runtime', async () => {
    await db.executor.updateTable('ai_funded_global_policy')
      .set({ enabled: true, allowed_model_ids: JSON.stringify(MODELS), revision: 1 })
      .where('policy_id', '=', 'default').execute();
    await insertUserMachine(db, {
      machineId: 'vps-old', clerkUserId: OWNER, handle: 'freeowner', status: 'running',
      imageVersion: 'v', provisionedAt: NOW, activationState: 'authorized',
    });
    expect(await initialize(db, 'vps-old')).toBe(true);
    await db.executor.updateTable('user_machines').set({ deleted_at: NOW }).where('machine_id', '=', 'vps-old').execute();
    await seed(db);
    expect(await initialize(db)).toBe(true);
    const ledger = await db.executor.selectFrom('ai_funded_credit_ledger').select(['entry_id', 'machine_id']).execute();
    expect(ledger).toEqual([{ entry_id: STARTER_ENTRY, machine_id: 'vps-old' }]);
    const balance = await db.executor.selectFrom('ai_funded_runtime_balances').select('credit_balance_microusd')
      .where('machine_id', '=', CONTAINER).executeTakeFirstOrThrow();
    expect(Number(balance.credit_balance_microusd)).toBe(0);
  });

  it('is idempotent when registration is retried', async () => {
    await seed(db);
    expect(await initialize(db)).toBe(true);
    expect(await initialize(db)).toBe(false);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toHaveLength(1);
    expect(await db.executor.selectFrom('ai_funded_runtime_policies').selectAll().execute()).toHaveLength(1);
  });

  it('funds nothing for a container that has not registered', async () => {
    await seed(db, 'starting');
    expect(await initialize(db)).toBe(false);
    expect(await db.executor.selectFrom('ai_funded_runtime_policies').selectAll().execute()).toHaveLength(0);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toHaveLength(0);
  });

  it('funds the runtime when it registers through the register route', async () => {
    await seed(db, 'starting');
    const secret = 's'.repeat(48);
    const routes = createContainerInternalRoutes({
      db, platformSecret: secret,
      lifecycle: { markRegistered: async (machineId, generation) => {
        await db.executor.updateTable('user_machines').set({ status: 'running' })
          .where('machine_id', '=', machineId).where('generation', '=', generation).execute();
        return 'ok';
      } },
      onRegistered: createContainerRegistrationFunding(db, { env: ENV, now: () => new Date(NOW) }),
    });
    const token = buildPlatformContainerRuntimeToken({ handle: 'freeowner', machineId: CONTAINER, runtimeSlot: 'primary' }, secret, 1);
    const response = await routes.request('/internal/containers/freeowner/register', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
        'x-matrix-machine-id': CONTAINER, 'x-matrix-runtime-slot': 'primary' },
      body: JSON.stringify({ generation: 1, bundleVersion: 'b2' }),
    });
    expect(response.status).toBe(200);
    expect(await db.executor.selectFrom('ai_funded_runtime_policies').selectAll().execute()).toHaveLength(1);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toHaveLength(1);
  });

  it('refuses a credential for a stopped free container', async () => {
    await seed(db);
    await initialize(db);
    await db.executor.updateTable('user_machines').set({ status: 'stopped' }).execute();
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => new Date(NOW) });
    await expect(repo.issueRuntimeCredential({ ownerId: OWNER, machineId: CONTAINER, runtimeSlot: 'primary' })).rejects.toThrow();
  });
});

describe.skipIf(!freeTierPostgresUrl)('free container starter credit under concurrent registration', () => {
  let scoped: ScopedPlatformDbs;
  beforeAll(async () => { scoped = await createScopedPlatformDbs('free_funding', 2); });
  afterAll(async () => { await scoped?.close(); });

  it('grants the starter credit once when many registrations race across pools', async () => {
    const [a, b] = scoped.pools as [PlatformDB, PlatformDB];
    await seed(a);
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) => initialize(index % 2 === 0 ? a : b)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await a.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toHaveLength(1);
    expect(await a.executor.selectFrom('ai_funded_runtime_policies').selectAll().execute()).toHaveLength(1);
    const balance = await a.executor.selectFrom('ai_funded_runtime_balances').select('credit_balance_microusd').executeTakeFirstOrThrow();
    expect(Number(balance.credit_balance_microusd)).toBe(5_000_000);
  });
});
