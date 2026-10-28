import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MANAGED_WORKERS_AI_MODEL_IDS } from '@matrix-os/contracts';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './funded-policy-db-test-helper.js';

const now = '2026-10-27T14:00:00.000Z';
const sonnet = 'anthropic/claude-sonnet-5';
const flash = MANAGED_WORKERS_AI_MODEL_IDS[0];
const ordinary = [sonnet, ...MANAGED_WORKERS_AI_MODEL_IDS];

describe('ordinary model updates reach existing formal customers', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });
  const repo = () => createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => new Date(now) });

  async function customer(id: string, models = [sonnet, flash]) {
    await insertUserMachine(db, { machineId: id, clerkUserId: `owner_${id}`, handle: id,
      runtimeSlot: 'primary', provisioningClass: 'customer', activationState: 'authorized',
      status: 'running', imageVersion: 'test', provisionedAt: now });
    await repo().setRuntimePolicy({ identity: { machineId: id, ownerId: `owner_${id}`, runtimeSlot: 'primary' },
      expectedRevision: 0, enabled: true, allowedModelIds: models, monthlyBudgetMicrousd: 1234567, expiresAt: null });
  }
  const policies = () => db.executor.selectFrom('ai_funded_runtime_policies').selectAll().orderBy('machine_id').execute();
  const global = () => db.executor.selectFrom('ai_funded_global_policy').selectAll().executeTakeFirstOrThrow();
  async function limits() {
    return {
      balances: await db.executor.selectFrom('ai_funded_runtime_balances').selectAll().orderBy('machine_id').execute(),
      ledger: await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute(),
      restrictions: await db.executor.selectFrom('ai_funded_credit_restrictions').selectAll().execute(),
    };
  }
  const preserved = (row: Awaited<ReturnType<typeof policies>>[number]) => {
    const { allowed_model_ids: _models, revision: _revision, updated_at: _updated, ...rest } = row;
    return rest;
  };

  it('appends globally enabled ordinary models to old policies without granting special models or touching money', async () => {
    await customer('alice', [flash, sonnet, 'typesafe/jev', 'anthropic/claude-opus-5']);
    await customer('bob');
    await repo().grantCredit({ identity: { machineId: 'alice', ownerId: 'owner_alice', runtimeSlot: 'primary' },
      entryId: 'test-grant', kind: 'promotional_grant', amountMicrousd: 987654, sourceReference: 'fixture' });
    await db.executor.updateTable('ai_funded_runtime_balances').set({ reserved_microusd: 125,
      month_spent_microusd: 456, month_reserved_microusd: 125, funding_shortfall_microusd: 7 }).where('machine_id', '=', 'alice').execute();
    const before = await policies(), money = await limits();
    await repo().updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [...ordinary, 'typesafe/jev', 'anthropic/claude-opus-5'] });
    const after = await policies();
    expect(after.map(preserved)).toEqual(before.map(preserved));
    expect(await limits()).toEqual(money);
    expect(after.map(row => row.revision)).toEqual([2, 2]);
    expect(JSON.parse(after[0].allowed_model_ids)).toEqual([flash, sonnet, 'typesafe/jev', 'anthropic/claude-opus-5', ...ordinary.filter(x => x !== flash && x !== sonnet)]);
    expect(JSON.parse(after[1].allowed_model_ids)).toEqual(ordinary);
  });

  it('preserves disabled, expired, zero-budget and suspended customer restrictions', async () => {
    await customer('alice');
    await db.executor.updateTable('user_machines').set({ status: 'suspended' }).where('machine_id', '=', 'alice').execute();
    await db.executor.updateTable('ai_funded_runtime_policies').set({ enabled: false, expires_at: '2026-01-01T00:00:00.000Z',
      monthly_budget_microusd: 0, next_issue_at: '2027-01-01T00:00:00.000Z' }).execute();
    await db.executor.insertInto('ai_funded_credit_restrictions').values({ machine_id: 'alice', owner_id: 'owner_alice',
      runtime_slot: 'primary', frozen: true, debt_microusd: 99, updated_at: now }).execute();
    const before = await policies(), money = await limits();
    await repo().updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: ordinary });
    expect((await policies()).map(preserved)).toEqual(before.map(preserved));
    expect(JSON.parse((await policies())[0].allowed_model_ids)).toEqual(ordinary);
    expect(await limits()).toEqual(money);
  });

  it('excludes previews, deleted or unauthorized customers, identity mismatches and missing policies', async () => {
    for (const id of ['preview', 'private', 'deleted', 'unpaid', 'mismatch', 'missing']) await customer(id);
    await db.executor.updateTable('user_machines').set({ provisioning_class: 'preview' }).where('machine_id', '=', 'preview').execute();
    await db.executor.updateTable('user_machines').set({ provisioning_class: 'private-preview', handle: 'pv-1-00000000',
      runtime_slot: 'pv-1-00000000', source_pr: 1, confirmed_bundle_version: 'reviewed' }).where('machine_id', '=', 'private').execute();
    await db.executor.updateTable('user_machines').set({ deleted_at: now }).where('machine_id', '=', 'deleted').execute();
    await db.executor.updateTable('user_machines').set({ activation_state: 'awaiting_billing' }).where('machine_id', '=', 'unpaid').execute();
    await db.executor.updateTable('ai_funded_runtime_policies').set({ owner_id: 'different_owner' }).where('machine_id', '=', 'mismatch').execute();
    await db.executor.deleteFrom('ai_funded_runtime_policies').where('machine_id', '=', 'missing').execute();
    const before = await policies(), money = await limits();
    await repo().updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: ordinary });
    expect(await policies()).toEqual(before);
    expect(await limits()).toEqual(money);
  });

  it('only appends globally enabled ordinary models, remains idempotent and preserves global revocation', async () => {
    await customer('alice');
    const addition = MANAGED_WORKERS_AI_MODEL_IDS[1];
    await repo().updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [sonnet, flash, addition, 'typesafe/jev'] });
    const aligned = await policies();
    expect(JSON.parse(aligned[0].allowed_model_ids)).toEqual([sonnet, flash, addition]);
    await repo().updateGlobalPolicy({ expectedRevision: 1, enabled: false, allowedModelIds: [sonnet, flash, addition] });
    expect(await policies()).toEqual(aligned);
    await repo().updateGlobalPolicy({ expectedRevision: 2, enabled: true, allowedModelIds: [sonnet] });
    expect(await policies()).toEqual(aligned);
    const issued = await repo().issueRuntimeCredential({ machineId: 'alice', ownerId: 'owner_alice', runtimeSlot: 'primary' });
    expect(issued.policy.allowedModelIds).toEqual([sonnet]);
  });

  it('rolls back both global and runtime writes when alignment would violate the 64-model bound', async () => {
    await customer('alice', Array.from({ length: 64 }, (_, n) => `custom/model-${n}`));
    const priorGlobal = await global(), before = await policies(), money = await limits();
    await expect(repo().updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: ordinary })).rejects.toThrow();
    expect(await global()).toEqual(priorGlobal);
    expect(await policies()).toEqual(before);
    expect(await limits()).toEqual(money);
  });

  it.each([123, true, null, {}, { models: [sonnet] },
    [123], [true], [null], [{}], [[]], [sonnet, sonnet], ['bad value'], ['@cf/unreviewed/model'],
    [...ordinary, 123], [...ordinary, sonnet]].map(value => ({ value })))(
    'rejects malformed stored model policy $value without rewriting it or publishing a global revision', async ({ value }) => {
      await customer('alice');
      await db.executor.updateTable('ai_funded_runtime_policies')
        .set({ allowed_model_ids: JSON.stringify(value) }).execute();
      const priorGlobal = await global(), before = await policies(), money = await limits();
      await expect(repo().updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: ordinary })).rejects.toThrow();
      expect(await global()).toEqual(priorGlobal);
      expect(await policies()).toEqual(before);
      expect(await limits()).toEqual(money);
    },
  );

  it('rejects stale global revisions without changing any runtime policy', async () => {
    await customer('alice');
    await repo().updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [sonnet, flash] });
    const before = await policies();
    await expect(repo().updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: ordinary }))
      .rejects.toMatchObject({ code: 'revision_conflict' });
    expect(await policies()).toEqual(before);
  });

  it('serializes competing global rollouts and only propagates the winning revision', async () => {
    await customer('alice');
    const outcomes = await Promise.allSettled([
      repo().updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [sonnet, flash, MANAGED_WORKERS_AI_MODEL_IDS[1]] }),
      repo().updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [sonnet, flash, MANAGED_WORKERS_AI_MODEL_IDS[2]] }),
    ]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    const winner = outcomes.find(outcome => outcome.status === 'fulfilled');
    expect(winner?.status === 'fulfilled' && winner.value.allowedModelIds).toEqual(JSON.parse((await global()).allowed_model_ids));
    expect(JSON.parse((await policies())[0].allowed_model_ids)).toEqual(JSON.parse((await global()).allowed_model_ids));
    expect((await policies())[0].revision).toBe(2);
  });

  it('aligns authorized secondary and failed customer runtimes without changing their lifecycle', async () => {
    await customer('alice');
    await db.executor.updateTable('user_machines').set({ runtime_slot: 'secondary', status: 'failed' }).execute();
    await db.executor.updateTable('ai_funded_runtime_policies').set({ runtime_slot: 'secondary' }).execute();
    const before = await policies();
    await repo().updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: ordinary });
    expect((await policies()).map(preserved)).toEqual(before.map(preserved));
    expect(JSON.parse((await policies())[0].allowed_model_ids)).toEqual(ordinary);
    expect(await db.executor.selectFrom('user_machines').select('status').executeTakeFirst()).toEqual({ status: 'failed' });
  });
});
