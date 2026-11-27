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
/** Runs on the admission's own connection when a fence lock is taken, to commit a plan change "while it waited". */
let onLock: ((executor: PlatformDB['executor'], lane: 'exclusive' | 'shared') => Promise<void>) | undefined;
vi.mock('../../packages/platform/src/account-deletion/repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/platform/src/account-deletion/repository.js')>();
  return {
    ...actual,
    lockAccountDeletionOwner: vi.fn(async (...args: Parameters<typeof actual.lockAccountDeletionOwner>) => {
      calls.push('exclusive');
      await actual.lockAccountDeletionOwner(...args);
      await onLock?.(args[0] as PlatformDB['executor'], 'exclusive');
    }),
    lockAccountDeletionOwnerShared: vi.fn(async (...args: Parameters<typeof actual.lockAccountDeletionOwnerShared>) => {
      calls.push('shared');
      await actual.lockAccountDeletionOwnerShared(...args);
      await onLock?.(args[0] as PlatformDB['executor'], 'shared');
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
  afterEach(async () => { onLock = undefined; vi.unstubAllEnvs(); await destroyTestPlatformDb(db); });

  async function authorizeOnce(identity: { ownerId: string; machineId: string; runtimeSlot: string }, modelId: string, arm?: () => void) {
    await db.transaction((trx) => initializeCustomerFundedStarterPolicy(trx, identity.machineId, { now: NOV.toISOString(), env: ENV }));
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => NOV,
      freeFunding: { dailyFundedSpendMicrousd: 100_000_000 } });
    const { credential } = await repo.issueRuntimeCredential(identity);
    calls.length = 0;
    arm?.();
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
      .where('entry_id', 'like', 'free-daily:%').execute()).toHaveLength(1);
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

  /** Switches the owner's stored plan the first time the given fence lane is taken. */
  function switchPlanOnLock(lane: 'exclusive' | 'shared', source: 'free' | 'stripe') {
    let done = false;
    onLock = async (executor, taken) => {
      if (done || taken !== lane) return;
      done = true;
      await executor.updateTable('billing_entitlements').set({ source }).execute();
    };
  }

  it('rereads the plan under the owner locks: an upgrade that lands while admission waits is funded as paid', async () => {
    const identity = { ownerId: 'user_upgrade', machineId: 'metal-upgrade', runtimeSlot: 'primary' };
    await insertFreeMetalRuntime(db, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: 'upgrade', at: NOV });
    await authorizeOnce(identity, FREE_MANAGED_MODEL_ID, () => switchPlanOnLock('exclusive', 'stripe'));
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').select('entry_id')
      .where('entry_id', 'like', 'free-daily:%').execute()).toHaveLength(0);
    expect(await db.executor.selectFrom('ai_funded_usage_reservations').select('free_funded').execute())
      .toEqual([{ free_funded: false }]);
  });

  it('refuses as busy, for a retry, when a downgrade to free lands while a paid admission waits', async () => {
    const identity = { ownerId: 'user_downgrade', machineId: 'metal-downgrade', runtimeSlot: 'primary' };
    await insertFreeMetalRuntime(db, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: 'downgrade', at: NOV });
    await db.executor.updateTable('billing_entitlements').set({ source: 'stripe' }).execute();
    await expect(authorizeOnce(identity, FREE_MANAGED_MODEL_ID, () => switchPlanOnLock('shared', 'free'))).rejects.toMatchObject({ code: 'busy' });
    expect(await db.executor.selectFrom('ai_funded_usage_reservations').select('reservation_id').execute()).toHaveLength(0);
  });

  it('a funding read whose owner upgraded while it waited grants no free allowance', async () => {
    const identity = { ownerId: 'user_readup', machineId: 'metal-readup', runtimeSlot: 'primary' };
    await insertFreeMetalRuntime(db, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle: 'readup', at: NOV });
    await db.transaction((trx) => initializeCustomerFundedStarterPolicy(trx, identity.machineId, { now: NOV.toISOString(), env: ENV }));
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => NOV,
      freeFunding: { dailyFundedSpendMicrousd: 100_000_000 } });
    switchPlanOnLock('exclusive', 'stripe');
    await repo.getRuntimeFundingSummary(identity);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').select('entry_id')
      .where('entry_id', 'like', 'free-daily:%').execute()).toHaveLength(0);
  });
});
