import { MANAGED_WORKERS_AI_MODEL_IDS } from '@matrix-os/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { initializeCustomerFundedStarterPolicy } from '../../packages/platform/src/customer-funded-starter-policy.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { FREE_MANAGED_MODEL_ID } from '../../packages/platform/src/free-tier/funded-policy.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertFreeMetalRuntime } from './free-funded-test-helper.js';

/**
 * Lock order of free funded admission with account deletion configured
 * (ENG-520 P7 fix round 1). The monthly allowance grant takes the exclusive
 * account-deletion fence, so a free authorize must take that fence
 * exclusively before anything else; taking the shared fence first and
 * upgrading it later deadlocks two admissions for one owner. A single PGlite
 * session cannot deadlock, so this records the order the fence helpers are
 * called in; the real-Postgres race lives in free-funded-policy.test.ts.
 */

const calls: string[] = [];
vi.mock('../../packages/platform/src/account-deletion/repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/platform/src/account-deletion/repository.js')>();
  return {
    ...actual,
    lockAccountDeletionOwner: vi.fn(async (...args: Parameters<typeof actual.lockAccountDeletionOwner>) => {
      calls.push('exclusive');
      return actual.lockAccountDeletionOwner(...args);
    }),
    lockAccountDeletionOwnerShared: vi.fn(async (...args: Parameters<typeof actual.lockAccountDeletionOwnerShared>) => {
      calls.push('shared');
      return actual.lockAccountDeletionOwnerShared(...args);
    }),
  };
});

const NOV = new Date('2026-11-20T12:00:00.000Z');
const ENV = {
  MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: 'true', MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'true',
  AI_FUNDED_CREDENTIAL_HASH_SECRET: 'h'.repeat(32),
};

describe('free funded admission lock order with account deletion configured', () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    vi.stubEnv('ACCOUNT_DELETION_SECRET', 'd'.repeat(40));
    await db.executor.updateTable('ai_funded_global_policy')
      .set({ enabled: true, allowed_model_ids: JSON.stringify(['anthropic/claude-sonnet-5', ...MANAGED_WORKERS_AI_MODEL_IDS]), revision: 1 })
      .where('policy_id', '=', 'default').execute();
  });
  afterEach(async () => { vi.unstubAllEnvs(); await destroyTestPlatformDb(db); });

  async function authorizeOnce(identity: { ownerId: string; machineId: string; runtimeSlot: string }, modelId: string) {
    await db.transaction((trx) => initializeCustomerFundedStarterPolicy(trx, identity.machineId, { now: NOV.toISOString(), env: ENV }));
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => NOV,
      freeFunding: { dailyFundedSpendMicrousd: 100_000_000 } });
    const { credential } = await repo.issueRuntimeCredential(identity);
    calls.length = 0;
    await repo.authorize({ credential: credential.token, requestId: 'request_lock_order', modelId, maxCostMicrousd: 1_000,
      billingMode: 'usage' });
    return [...calls];
  }

  it('takes the deletion fence exclusively, and never shared, for a free authorize that grants the allowance', async () => {
    const identity = { ownerId: 'user_freelock', machineId: 'metal-free-lock', runtimeSlot: 'primary' };
    await insertFreeMetalRuntime(db, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: 'freelock', at: NOV });
    const order = await authorizeOnce(identity, FREE_MANAGED_MODEL_ID);
    expect(order[0]).toBe('exclusive');
    expect(order).not.toContain('shared');
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').select('entry_id')
      .where('entry_id', 'like', 'free-monthly:%').execute()).toHaveLength(1);
  });

  it('keeps the shared funding fence for a paid authorize', async () => {
    const identity = { ownerId: 'user_paidlock', machineId: 'vps-paid-lock', runtimeSlot: 'primary' };
    await insertUserMachine(db, {
      machineId: identity.machineId, clerkUserId: identity.ownerId, handle: 'paidlock', status: 'running', imageVersion: 'b1',
      provisionedAt: NOV.toISOString(), activationState: 'authorized',
    });
    const order = await authorizeOnce(identity, FREE_MANAGED_MODEL_ID);
    expect(order[0]).toBe('shared');
    expect(order).not.toContain('exclusive');
  });
});
