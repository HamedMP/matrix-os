import { createHash } from 'node:crypto';
import { MANAGED_WORKERS_AI_MODEL_IDS } from '@matrix-os/contracts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { initializeCustomerFundedStarterPolicy } from '../../packages/platform/src/customer-funded-starter-policy.js';
import { alignCustomerOrdinaryModels } from '../../packages/platform/src/customer-ordinary-model-policy.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createScopedPlatformDbs, freeTierPostgresUrl, type ScopedPlatformDbs } from './free-tier-postgres-helper.js';
import { FREE_TEST_HOST_ID, insertFreeMetalRuntime } from './free-funded-test-helper.js';
import { useCustomerVpsFixture } from './customer-vps-service-test-helper.js';

/**
 * Funded AI for a free metal runtime (spec 2691, ENG-520 Task P7; ported from
 * PR #3437's free container runtime suite). Registration creates a policy
 * limited to the managed GLM model, a balance, and the once-per-owner starter
 * credit, with a month budget that also covers the $5 monthly allowance.
 * Faults detected: a free runtime funded for other models, starter credit
 * granted twice, a stale $5 budget never raised, and a metal free runtime that
 * registers without its starter credit.
 */

const NOW = '2026-11-11T12:00:00.000Z';
const OWNER = 'user_freeowner';
const MACHINE = 'metal-free-1';
const GLM_FLASH = '@cf/zai-org/glm-5.3-flash';
const MODELS = ['anthropic/claude-sonnet-5', ...MANAGED_WORKERS_AI_MODEL_IDS];
const ENV = {
  MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: 'true', MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'true',
  AI_FUNDED_CREDENTIAL_HASH_SECRET: 'h'.repeat(32),
};
const STARTER_ENTRY = `starter-lifetime:${createHash('sha256').update(OWNER).digest('hex')}`;

async function enableGlobalPolicy(db: PlatformDB) {
  await db.executor.updateTable('ai_funded_global_policy')
    .set({ enabled: true, allowed_model_ids: JSON.stringify(MODELS), revision: 1 })
    .where('policy_id', '=', 'default').execute();
}

async function seed(db: PlatformDB, status = 'running') {
  await enableGlobalPolicy(db);
  await insertFreeMetalRuntime(db, { machineId: MACHINE, clerkUserId: OWNER, handle: 'freeowner', at: new Date(NOW), status });
}

const initialize = (db: PlatformDB, machineId = MACHINE) => db.transaction((trx) =>
  initializeCustomerFundedStarterPolicy(trx, machineId, { now: NOW, env: ENV }));

describe('funded AI for a free metal runtime', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it('creates a policy limited to the managed model, a balance, and the once-per-owner starter credit', async () => {
    await seed(db);
    expect(await initialize(db)).toBe(true);
    const policy = await db.executor.selectFrom('ai_funded_runtime_policies').selectAll().executeTakeFirstOrThrow();
    expect(policy).toMatchObject({ machine_id: MACHINE, owner_id: OWNER, runtime_slot: 'primary', enabled: true });
    expect(JSON.parse(policy.allowed_model_ids)).toEqual([GLM_FLASH]);
    expect(Number(policy.monthly_budget_microusd)).toBe(25_000_000);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').select(['entry_id', 'amount_microusd']).execute())
      .toEqual([{ entry_id: STARTER_ENTRY, amount_microusd: 5_000_000 }]);
    expect(await db.executor.selectFrom('ai_funded_runtime_balances').select('credit_balance_microusd').executeTakeFirst())
      .toEqual({ credit_balance_microusd: 5_000_000 });
  });

  it('keeps a paid metal runtime on the ordinary models and the $5 budget', async () => {
    await enableGlobalPolicy(db);
    await insertFreeMetalRuntime(db, { machineId: MACHINE, clerkUserId: OWNER, handle: 'freeowner', at: new Date(NOW), freeEntitlement: false });
    expect(await initialize(db)).toBe(true);
    const policy = await db.executor.selectFrom('ai_funded_runtime_policies').selectAll().executeTakeFirstOrThrow();
    expect(JSON.parse(policy.allowed_model_ids)).not.toEqual([GLM_FLASH]);
    expect(Number(policy.monthly_budget_microusd)).toBe(5_000_000);
  });

  it.each([5_000_000, 10_000_000])('raises a free runtime budget left at an old default (%i), and leaves a custom budget alone', async (oldDefault) => {
    await seed(db);
    await initialize(db);
    // Runtimes registered earlier kept the $5 starter budget or the $5-a-month allowance budget.
    await db.executor.updateTable('ai_funded_runtime_policies').set({ monthly_budget_microusd: oldDefault })
      .where('machine_id', '=', MACHINE).execute();
    expect(await initialize(db)).toBe(true);
    const raised = await db.executor.selectFrom('ai_funded_runtime_policies').select(['monthly_budget_microusd', 'revision'])
      .where('machine_id', '=', MACHINE).executeTakeFirstOrThrow();
    // The starter credit plus the $20 monthly cap on daily allowances.
    expect(Number(raised.monthly_budget_microusd)).toBe(25_000_000);
    expect(raised.revision).toBe(2);

    await db.executor.updateTable('ai_funded_runtime_policies').set({ monthly_budget_microusd: 20_000_000 })
      .where('machine_id', '=', MACHINE).execute();
    await initialize(db);
    const custom = await db.executor.selectFrom('ai_funded_runtime_policies').select('monthly_budget_microusd')
      .where('machine_id', '=', MACHINE).executeTakeFirstOrThrow();
    expect(Number(custom.monthly_budget_microusd)).toBe(20_000_000);
  });

  it('issues a runtime credential for the free metal runtime', async () => {
    await seed(db);
    await initialize(db);
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => new Date(NOW) });
    const issued = await repo.issueRuntimeCredential({ ownerId: OWNER, machineId: MACHINE, runtimeSlot: 'primary' });
    expect(issued.credential.token).toEqual(expect.any(String));
  });

  it('does not repeat starter credit for an owner who already received it on another runtime', async () => {
    await enableGlobalPolicy(db);
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
      .where('machine_id', '=', MACHINE).executeTakeFirstOrThrow();
    expect(Number(balance.credit_balance_microusd)).toBe(0);
  });

  it('is idempotent when registration is retried', async () => {
    await seed(db);
    expect(await initialize(db)).toBe(true);
    expect(await initialize(db)).toBe(false);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toHaveLength(1);
    expect(await db.executor.selectFrom('ai_funded_runtime_policies').selectAll().execute()).toHaveLength(1);
  });

  it('funds nothing for a metal runtime that has not registered', async () => {
    await seed(db, 'provisioning');
    expect(await initialize(db)).toBe(false);
    expect(await db.executor.selectFrom('ai_funded_runtime_policies').selectAll().execute()).toHaveLength(0);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toHaveLength(0);
  });

  it('funds nothing while the global policy is disabled, then grants once it is live', async () => {
    await seed(db);
    await db.executor.updateTable('ai_funded_global_policy').set({ enabled: false }).where('policy_id', '=', 'default').execute();
    expect(await initialize(db)).toBe(false);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toHaveLength(0);
    await enableGlobalPolicy(db);
    expect(await initialize(db)).toBe(true);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toHaveLength(1);
  });

  it('keeps a free metal runtime on the managed model when the global policy realigns ordinary models', async () => {
    await seed(db);
    await initialize(db);
    await insertUserMachine(db, {
      machineId: 'vps-paid', clerkUserId: 'user_paidowner', handle: 'paidowner', status: 'running',
      imageVersion: 'v', provisionedAt: NOW, activationState: 'authorized',
    });
    await initialize(db, 'vps-paid');
    await db.executor.updateTable('ai_funded_runtime_policies').set({ allowed_model_ids: JSON.stringify(['anthropic/claude-sonnet-5']) })
      .where('machine_id', '=', 'vps-paid').execute();
    await db.transaction((trx) => alignCustomerOrdinaryModels(trx, MODELS, NOW));
    const models = async (machineId: string) => JSON.parse((await db.executor.selectFrom('ai_funded_runtime_policies')
      .select('allowed_model_ids').where('machine_id', '=', machineId).executeTakeFirstOrThrow()).allowed_model_ids) as string[];
    expect(await models(MACHINE)).toEqual([GLM_FLASH]);
    expect((await models('vps-paid')).length).toBeGreaterThan(1);
  });

  it('refuses a credential for a stopped free metal runtime', async () => {
    await seed(db);
    await initialize(db);
    await db.executor.updateTable('user_machines').set({ status: 'stopped' }).execute();
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => new Date(NOW) });
    await expect(repo.issueRuntimeCredential({ ownerId: OWNER, machineId: MACHINE, runtimeSlot: 'primary' })).rejects.toThrow();
  });
});

describe('free metal runtime registration', () => {
  let db: PlatformDB;
  const { createService } = useCustomerVpsFixture((value) => { db = value!; });
  const METAL_MACHINE_ID = '6a0c4f8e-3b1d-4f2a-9c7e-1d2b3c4d5e6f';
  const IMAGE_VERSION = 'matrix-os-host-2026.11.20-1';
  const BUNDLE_SHA = 'c'.repeat(64);

  beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('a metal free runtime receives the starter credit on registration', async () => {
    await enableGlobalPolicy(db);
    await insertFreeMetalRuntime(db, {
      machineId: METAL_MACHINE_ID, clerkUserId: OWNER, handle: 'freeowner', at: new Date('2026-04-26T11:59:00.000Z'),
      status: 'provisioning',
    });
    await db.executor.updateTable('user_machines').set({
      metal_vm_id: 'vm_0123456789abcdef01234567', private_address: '10.77.0.9',
      target_bundle_version: IMAGE_VERSION, target_bundle_sha256: BUNDLE_SHA, image_version: IMAGE_VERSION,
      registration_token_hash: hashRegistrationToken('registration-token'),
      registration_token_expires_at: '2099-01-01T00:00:00.000Z',
    }).where('machine_id', '=', METAL_MACHINE_ID).execute();
    expect((await db.executor.selectFrom('user_machines').select('metal_host_id').executeTakeFirstOrThrow()).metal_host_id)
      .toBe(FREE_TEST_HOST_ID);

    const { service } = createService();
    await expect(service.register('registration-token', {
      provider: 'metal', machineId: METAL_MACHINE_ID, serverRef: METAL_MACHINE_ID,
      imageVersion: IMAGE_VERSION, bundleSha256: BUNDLE_SHA, healthy: true,
    })).resolves.toEqual({ registered: true, status: 'running' });

    expect(await db.executor.selectFrom('ai_funded_credit_ledger').select(['entry_id', 'amount_microusd', 'machine_id']).execute())
      .toEqual([{ entry_id: STARTER_ENTRY, amount_microusd: 5_000_000, machine_id: METAL_MACHINE_ID }]);
    const policy = await db.executor.selectFrom('ai_funded_runtime_policies').selectAll()
      .where('machine_id', '=', METAL_MACHINE_ID).executeTakeFirstOrThrow();
    expect(JSON.parse(policy.allowed_model_ids)).toEqual([GLM_FLASH]);
    expect(Number(policy.monthly_budget_microusd)).toBe(25_000_000);
  });
});

describe.skipIf(!freeTierPostgresUrl)('free metal starter credit under concurrent registration', () => {
  let scoped: ScopedPlatformDbs;
  beforeAll(async () => { scoped = await createScopedPlatformDbs('free_metal_funding', 2); });
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
