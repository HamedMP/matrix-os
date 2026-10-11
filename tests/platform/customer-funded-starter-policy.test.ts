import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { initializeCustomerFundedStarterPolicy } from '../../packages/platform/src/customer-funded-starter-policy.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { createMockHetznerClient, createMockCustomerVpsSystemStore } from './customer-vps-fixtures.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const now = '2026-10-10T18:00:00.000Z';
const expiresAt = '2026-11-10T18:00:00.000Z';
const models = ['anthropic/claude-sonnet-5', '@cf/zai-org/glm-5.3-flash'];
const enabledEnv = {
  MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: 'true', MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'true',
  AI_FUNDED_CREDENTIAL_HASH_SECRET: 'h'.repeat(32),
};

describe('customer starter policy initialization', () => {
  let db: PlatformDB;
  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, { machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112', clerkUserId: 'owner', handle: 'alice',
      runtimeSlot: 'primary', provisioningClass: 'customer', activationState: 'authorized',
      status: 'running', imageVersion: 'reviewed', provisionedAt: now });
    await db.executor.updateTable('ai_funded_global_policy').set({ enabled: true,
      allowed_model_ids: JSON.stringify([...models, 'anthropic/claude-opus-5']), revision: 1 })
      .where('policy_id', '=', 'default').execute();
  });
  afterEach(async () => { await destroyTestPlatformDb(db); vi.unstubAllEnvs(); });
  const initialize = (env: NodeJS.ProcessEnv = enabledEnv) => db.transaction(trx =>
    initializeCustomerFundedStarterPolicy(trx, '9f05824c-8d0a-4d83-9cb4-b312d43ff112', { now, env }));
  const policies = () => db.executor.selectFrom('ai_funded_runtime_policies').selectAll().execute();


  it('initializes inside successful normal VPS registration, and rejected registrations leave no policy', async () => {
    for (const [key, value] of Object.entries(enabledEnv)) vi.stubEnv(key, value);
    await db.executor.updateTable('user_machines').set({ status: 'provisioning', hetzner_server_id: 123,
      registration_token_hash: hashRegistrationToken('registration'), registration_token_expires_at: expiresAt })
      .where('machine_id', '=', '9f05824c-8d0a-4d83-9cb4-b312d43ff112').execute();
    const service = createCustomerVpsService({ db,
      config: loadCustomerVpsConfig({ PLATFORM_SECRET: 'test-platform', HETZNER_API_TOKEN: 'test-hetzner',
        S3_ACCESS_KEY_ID: 'test-r2', S3_SECRET_ACCESS_KEY: 'test-r2-secret',
        S3_ENDPOINT: 'https://r2.example', R2_BUCKET: 'test' }),
      hetzner: createMockHetznerClient(), systemStore: createMockCustomerVpsSystemStore(),
      now: () => new Date(now) });
    const request = { machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112', hetznerServerId: 123, publicIPv4: '203.0.113.10', imageVersion: 'reviewed' };
    await expect(service.register('wrong', request)).rejects.toMatchObject({ code: 'registration_rejected' });
    expect(await policies()).toEqual([]);
    vi.stubEnv('AI_FUNDED_CREDENTIAL_HASH_SECRET', 'invalid');
    await expect(service.register('registration', request)).rejects.toThrow();
    expect(await db.executor.selectFrom('user_machines').select(['status', 'registration_token_hash']).execute()).toEqual([
      expect.objectContaining({ status: 'provisioning', registration_token_hash: hashRegistrationToken('registration') })]);
    vi.stubEnv('AI_FUNDED_CREDENTIAL_HASH_SECRET', 'h'.repeat(32));
    await expect(service.register('registration', request)).resolves.toMatchObject({ registered: true });
    expect(await policies()).toEqual([expect.objectContaining({ enabled: true, revision: 1 })]);
    await expect(service.register('registration', request)).rejects.toMatchObject({ code: 'already_registered' });
    expect(await policies()).toHaveLength(1);
  });

  it('creates ordinary policy and permanent five-dollar lifetime entitlement atomically without a promotion campaign', async () => {
    expect(await initialize()).toBe(true);
    expect(await policies()).toEqual([expect.objectContaining({ enabled: true, owner_id: 'owner',
      runtime_slot: 'primary', revision: 1, monthly_budget_microusd: 5000000, expires_at: null,
      allowed_model_ids: JSON.stringify(models) })]);
    expect(await db.executor.selectFrom('ai_funded_runtime_balances').selectAll().execute()).toEqual([
      expect.objectContaining({ credit_balance_microusd: 5000000, reserved_microusd: 0, month_spent_microusd: 0 })]);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toEqual([
      expect.objectContaining({ kind: 'promotional_grant', amount_microusd: 5000000, expires_at: null })]);
    expect(await initialize()).toBe(false);
  });

  it.each(['MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED', 'MATRIX_FUNDED_AI_RUNTIME_ENABLED'])('does nothing when %s is off', async key => {
    expect(await initialize({ ...enabledEnv, [key]: 'false' })).toBe(false);
    expect(await policies()).toEqual([]);
  });

  it.each([
    { status: 'provisioning' as const }, { status: 'failed' as const },
    { activation_state: 'awaiting_billing' }, { deleted_at: now },
    { provisioning_class: 'private-preview', source_pr: 1, handle: 'pv-1-00000000', runtime_slot: 'pv-1-00000000', confirmed_bundle_version: 'reviewed' },
    { provisioning_class: 'preview' },
    { runtime_slot: 'org:team' }, { runtime_slot: 'preview' }, { runtime_slot: 'reseller:test' },
  ])('does not initialize an ineligible machine: %j', async changes => {
    await db.executor.updateTable('user_machines').set(changes).where('machine_id', '=', '9f05824c-8d0a-4d83-9cb4-b312d43ff112').execute();
    expect(await initialize()).toBe(false);
    expect(await policies()).toEqual([]);
  });

  it('retains intentional disabled policy and every existing balance/hold counter', async () => {
    await initialize();
    await db.executor.updateTable('ai_funded_runtime_policies').set({ enabled: false, revision: 7,
      allowed_model_ids: '[]', monthly_budget_microusd: 123, expires_at: null }).where('machine_id', '=', '9f05824c-8d0a-4d83-9cb4-b312d43ff112').execute();
    await db.executor.updateTable('ai_funded_runtime_balances').set({ credit_balance_microusd: 4000000,
      reserved_microusd: 1000, month_spent_microusd: 1000000, month_reserved_microusd: 1000,
      funding_shortfall_microusd: 10 }).where('machine_id', '=', '9f05824c-8d0a-4d83-9cb4-b312d43ff112').execute();
    const before = await policies();
    const balance = await db.executor.selectFrom('ai_funded_runtime_balances').selectAll().execute();
    expect(await initialize()).toBe(false);
    expect(await policies()).toEqual(before);
    expect(await db.executor.selectFrom('ai_funded_runtime_balances').selectAll().execute()).toEqual(balance);
  });

  it('initializes a missing policy without replacing pre-existing spent, reserved or shortfall balances', async () => {
    await initialize();
    await db.executor.deleteFrom('ai_funded_runtime_policies').where('machine_id', '=', '9f05824c-8d0a-4d83-9cb4-b312d43ff112').execute();
    await db.executor.updateTable('ai_funded_runtime_balances').set({ credit_balance_microusd: 1234,
      reserved_microusd: 500, month_spent_microusd: 700, month_reserved_microusd: 500,
      funding_shortfall_microusd: 12 }).execute();
    const before = await db.executor.selectFrom('ai_funded_runtime_balances').selectAll().execute();
    expect(await initialize()).toBe(true);
    expect(await db.executor.selectFrom('ai_funded_runtime_balances').selectAll().execute()).toEqual(before);
  });

  it('recognizes the historical permanent starter grant and never restores consumed credit', async () => {
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => new Date(now) });
    const identity = { ownerId: 'owner', machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112', runtimeSlot: 'primary' };
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true,
      allowedModelIds: models, monthlyBudgetMicrousd: 5000000, expiresAt: null });
    await repo.grantCredit({ identity, entryId: 'manual-main-chat-20261008-permanent-5usd:test',
      kind: 'promotional_grant', amountMicrousd: 5000000,
      sourceReference: 'user-authorized-main-chat-20261008-permanent-5usd', expiresAt: null });
    await db.executor.updateTable('ai_funded_runtime_balances').set({ credit_balance_microusd: 1234,
      promotional_balance_microusd: 1234, month_spent_microusd: 4998766, reserved_microusd: 100 }).execute();
    await db.executor.updateTable('ai_funded_promotional_grant_balances').set({ remaining_microusd: 1234 }).execute();
    const balances = await db.executor.selectFrom('ai_funded_runtime_balances').selectAll().execute();
    const ledger = await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute();
    expect(await initialize()).toBe(false);
    expect(await db.executor.selectFrom('ai_funded_runtime_balances').selectAll().execute()).toEqual(balances);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toEqual(ledger);
  });

  it('preserves an enabled existing policy while issuing only its missing lifetime grant', async () => {
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => new Date(now) });
    await repo.setRuntimePolicy({ identity: { ownerId: 'owner', machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112', runtimeSlot: 'primary' },
      expectedRevision: 0, enabled: true, allowedModelIds: models, monthlyBudgetMicrousd: 7000000, expiresAt: null });
    const before = await policies();
    expect(await initialize()).toBe(true);
    expect(await policies()).toEqual(before);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toHaveLength(1);
    expect(await initialize()).toBe(false);
  });

  it.each([
    { amountMicrousd: 4000000, kind: 'promotional_grant' as const, expiresAt: null },
    { amountMicrousd: 5000000, kind: 'addon_grant' as const, expiresAt: null },
    { amountMicrousd: 5000000, kind: 'promotional_grant' as const, expiresAt },
  ])('fails closed on conflicting historical starter evidence: %j', async grant => {
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => new Date(now) });
    const identity = { ownerId: 'owner', machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112', runtimeSlot: 'primary' };
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true,
      allowedModelIds: models, monthlyBudgetMicrousd: 5000000, expiresAt: null });
    await repo.grantCredit({ identity, entryId: 'manual-main-chat-20261008-permanent-5usd:test',
      sourceReference: 'user-authorized-main-chat-20261008-permanent-5usd', ...grant });
    const before = await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute();
    await expect(initialize()).rejects.toThrow();
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toEqual(before);
  });

  it('does not enable or grant credit to an existing opt-out or expired policy', async () => {
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => new Date(now) });
    const identity = { ownerId: 'owner', machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112', runtimeSlot: 'primary' };
    await repo.setRuntimePolicy({ identity, expectedRevision: 0, enabled: false,
      allowedModelIds: models, monthlyBudgetMicrousd: 5000000, expiresAt: null });
    expect(await initialize()).toBe(false);
    await db.executor.updateTable('ai_funded_runtime_policies').set({ enabled: true, expires_at: now }).execute();
    expect(await initialize()).toBe(false);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toEqual([]);
  });

  it.each(['2026-10-10T18:00:00Z', 'not-a-time'])('does not grant from expired or unreadable policy time: %s', async expiresAt => {
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), now: () => new Date(now) });
    await repo.setRuntimePolicy({ identity: { ownerId: 'owner', machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112', runtimeSlot: 'primary' },
      expectedRevision: 0, enabled: true, allowedModelIds: models, monthlyBudgetMicrousd: 5000000,
      expiresAt: expiresAt === 'not-a-time' ? null : expiresAt });
    if (expiresAt === 'not-a-time') await db.executor.updateTable('ai_funded_runtime_policies').set({ expires_at: expiresAt }).execute();
    const before = await policies();
    expect(await initialize()).toBe(false);
    expect(await policies()).toEqual(before);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toEqual([]);
  });

  it('preserves the winning policy across concurrent initializer retries', async () => {
    await Promise.all([initialize(), initialize(), initialize()]);
    expect(await policies()).toHaveLength(1);
    expect((await policies())[0].revision).toBe(1);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toHaveLength(1);
    expect(await db.executor.selectFrom('ai_funded_runtime_balances').select('credit_balance_microusd').execute()).toEqual([{ credit_balance_microusd: 5000000 }]);
  });

  it('denies starter activation throughout account deletion and allows cancellation recovery', async () => {
    const secret = 'account-deletion-secret-at-least-32-bytes';
    const repo = new AccountDeletionRepository(db.kysely, { secret, now: () => new Date(now) });
    await repo.accept({ clerkUserId: 'owner', appleTokens: [] }, false);
    for (const status of ['scheduled', 'processing', 'completed'] as const) {
      await db.executor.updateTable('account_deletion_jobs').set({ status }).execute();
      await expect(initialize({ ...enabledEnv, ACCOUNT_DELETION_SECRET: secret })).rejects.toThrow('Account deletion is pending');
      expect(await policies()).toEqual([]);
      expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toEqual([]);
    }
    await db.executor.updateTable('account_deletion_jobs').set({ status: 'cancelled' }).execute();
    expect(await initialize({ ...enabledEnv, ACCOUNT_DELETION_SECRET: secret })).toBe(true);
  });

  it('does not mint another lifetime entitlement when the same owner replaces a primary machine', async () => {
    await initialize();
    const before = await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute();
    await db.executor.updateTable('user_machines').set({ runtime_slot: 'retired', deleted_at: now }).execute();
    const machineId = '1c7b76ab-2703-4cc4-b618-1bc305a32fc1';
    await insertUserMachine(db, { machineId, clerkUserId: 'owner', handle: 'replacement', runtimeSlot: 'primary',
      provisioningClass: 'customer', activationState: 'authorized', status: 'running', imageVersion: 'reviewed', provisionedAt: now });
    expect(await db.transaction(trx => initializeCustomerFundedStarterPolicy(trx, machineId, { now, env: enabledEnv }))).toBe(true);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toEqual(before);
    expect(await db.executor.selectFrom('ai_funded_runtime_balances').select('credit_balance_microusd')
      .where('machine_id', '=', machineId).executeTakeFirstOrThrow()).toEqual({ credit_balance_microusd: 0 });
  });

  it('does not create a policy when the global policy is disabled or has no supported ordinary model', async () => {
    await db.executor.updateTable('ai_funded_global_policy').set({ enabled: false }).execute();
    expect(await initialize()).toBe(false);
    await db.executor.updateTable('ai_funded_global_policy').set({ enabled: true, allowed_model_ids: '["typesafe/jev"]' }).execute();
    expect(await initialize()).toBe(false);
    expect(await policies()).toEqual([]);
  });

  it('does not depend on or renew an unrelated optional promotion campaign', async () => {
    expect(await initialize({ ...enabledEnv, AI_FUNDED_PROMOTIONAL_GRANT_ENABLED: 'true',
      AI_FUNDED_PROMOTIONAL_GRANT_CAMPAIGN_ID: 'other-campaign', AI_FUNDED_PROMOTIONAL_GRANT_MICROUSD: '10000000',
      AI_FUNDED_PROMOTIONAL_GRANT_EXPIRES_AT: now })).toBe(true);
    expect((await policies())[0]).toMatchObject({ expires_at: null, monthly_budget_microusd: 5000000 });
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toHaveLength(1);
  });

  it('fails atomically without the real configured hash secret', async () => {
    await expect(initialize({ ...enabledEnv, AI_FUNDED_CREDENTIAL_HASH_SECRET: undefined })).rejects.toThrow();
    expect(await policies()).toEqual([]);
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toEqual([]);
  });
});
