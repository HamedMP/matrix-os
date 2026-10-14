import { createHash } from 'node:crypto';
import { PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { initializeCustomerFundedStarterPolicy } from '../../packages/platform/src/customer-funded-starter-policy.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { createPlatformDb, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createMockHetznerClient, createMockCustomerVpsSystemStore } from './customer-vps-fixtures.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const activatedAt = '2026-10-10T18:00:00.000Z';
const now = '2026-10-14T18:00:00.000Z';
const modelId = 'anthropic/claude-sonnet-5';
const identity = { ownerId: 'starter-backfill-owner', machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112', runtimeSlot: 'primary' };
const env = {
  MATRIX_FUNDED_AI_CONTROL_PLANE_ENABLED: 'true', MATRIX_FUNDED_AI_RUNTIME_ENABLED: 'true',
  AI_FUNDED_CREDENTIAL_HASH_SECRET: 'h'.repeat(32), AI_FUNDED_PROMOTIONAL_GRANT_ENABLED: 'false',
};
const lifetimeEntryId = `starter-lifetime:${createHash('sha256').update(identity.ownerId).digest('hex')}`;

describe('ENG-291 completed customer starter recovery', () => {
  let db: PlatformDB;
  let secondDb: PlatformDB | undefined;
  let service: ReturnType<typeof createCustomerVpsService>;
  let repository: ReturnType<typeof createAiFundedPolicyRepository>;

  beforeEach(async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    ({ db } = await createTestPlatformDb());
    await insertUserMachine(db, {
      machineId: identity.machineId, clerkUserId: identity.ownerId, handle: 'starter-backfill',
      runtimeSlot: 'primary', provisioningClass: 'customer', activationState: 'authorized',
      status: 'running', imageVersion: 'reviewed-fixture', provisionedAt: activatedAt,
      hetznerServerId: 123456, publicIPv4: '203.0.113.10',
    });
    await db.executor.updateTable('user_machines').set({ activation_authorized_at: activatedAt,
      last_seen_at: now }).where('machine_id', '=', identity.machineId).execute();
    await db.executor.updateTable('ai_funded_global_policy').set({ enabled: true,
      allowed_model_ids: JSON.stringify([modelId]), revision: 1 }).where('policy_id', '=', 'default').execute();
    repository = createAiFundedPolicyRepository({ db, credentialHashSecret: env.AI_FUNDED_CREDENTIAL_HASH_SECRET,
      now: () => new Date(now) });
    service = createCustomerVpsService({ db,
      config: loadCustomerVpsConfig({ PLATFORM_SECRET: 'fixture-platform', HETZNER_API_TOKEN: 'fixture-hetzner',
        S3_ACCESS_KEY_ID: 'fixture-r2', S3_SECRET_ACCESS_KEY: 'fixture-r2-secret',
        S3_ENDPOINT: 'https://r2.example', R2_BUCKET: 'fixture' }),
      hetzner: createMockHetznerClient(), systemStore: createMockCustomerVpsSystemStore(),
      now: () => new Date(now) });
  });

  afterEach(async () => {
    try { await secondDb?.destroy(); }
    finally {
      secondDb = undefined;
      try { await destroyTestPlatformDb(db); }
      finally { vi.unstubAllEnvs(); }
    }
  });

  const initialize = (target: PlatformDB = db) => initializeCustomerFundedStarterPolicy(target,
    identity.machineId, { now, env });
  const policy = () => db.executor.selectFrom('ai_funded_runtime_policies').selectAll()
    .where('machine_id', '=', identity.machineId).executeTakeFirst();
  const ledger = () => db.executor.selectFrom('ai_funded_credit_ledger').selectAll()
    .where('owner_id', '=', identity.ownerId).orderBy('entry_id').execute();
  const balances = () => db.executor.selectFrom('ai_funded_runtime_balances').selectAll()
    .where('machine_id', '=', identity.machineId).executeTakeFirst();
  const grants = () => db.executor.selectFrom('ai_funded_promotional_grant_balances').selectAll()
    .where('machine_id', '=', identity.machineId).orderBy('grant_entry_id').execute();
  const snapshot = async () => ({ policy: await policy(), ledger: await ledger(),
    balance: await balances(), grants: await grants() });

  it('automatically reconciles an eligible owner whose activation completed before rollout (RED)', async () => {
    expect(await snapshot()).toEqual({ policy: undefined, ledger: [], balance: undefined, grants: [] });
    // Exercise the existing automatic entry point, never the initializer control.
    // No registration/payment replay, live provider request or operator repair.
    await service.reconcileProvisioning();
    await service.reconcileProvisioning();
    expect(await policy(), 'completed running owner must be visited by automatic recovery').toMatchObject({
      owner_id: identity.ownerId, enabled: true, runtime_slot: 'primary',
      allowed_model_ids: JSON.stringify([modelId]), expires_at: null,
    });
    expect(await ledger()).toEqual([expect.objectContaining({ entry_id: lifetimeEntryId,
      amount_microusd: 5_000_000, source_reference: 'matrix-ai-lifetime-starter', expires_at: null })]);
    expect(await balances()).toMatchObject({ credit_balance_microusd: 5_000_000 });
    expect(await repository.getRuntimeFundingSummary(identity)).toMatchObject({
      policy: { enabled: true, allowedModelIds: [modelId] },
    });
  });

  it('direct initializer control repairs the same completed state once without activation replay', async () => {
    await expect(repository.getRuntimeFundingSummary(identity)).rejects.toMatchObject({ code: 'identity_mismatch' });
    expect(await initialize()).toBe(true);
    const before = await snapshot();
    expect(await initialize()).toBe(false);
    expect(await snapshot()).toEqual(before);
    expect(before.ledger).toEqual([expect.objectContaining({ entry_id: lifetimeEntryId, amount_microusd: 5_000_000 })]);
    expect(await repository.getRuntimeFundingSummary(identity)).toMatchObject({
      policy: { enabled: true, allowedModelIds: [modelId] }, funding: { creditBalanceMicrousd: 5_000_000 },
    });
  });

  it('preserves a disabled policy with no starter history throughout recovery and direct retries', async () => {
    await repository.setRuntimePolicy({ identity, expectedRevision: 0, enabled: false,
      allowedModelIds: [modelId], monthlyBudgetMicrousd: 5_000_000, expiresAt: null });
    const before = await snapshot();
    await service.reconcileProvisioning();
    expect(await Promise.all([initialize(), initialize()])).toEqual([false, false]);
    expect(await snapshot()).toEqual(before);
    expect(await ledger()).toEqual([]);
  });

  it.each(['lifetime', 'historical'] as const)('never refills consumed %s starter credit or changes hold counters', async provenance => {
    await repository.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true,
      allowedModelIds: [modelId], monthlyBudgetMicrousd: 5_000_000, expiresAt: null });
    await repository.grantCredit({ identity,
      entryId: provenance === 'lifetime' ? lifetimeEntryId : 'manual-main-chat-20261008-permanent-5usd:fixture',
      kind: 'promotional_grant', amountMicrousd: 5_000_000, expiresAt: null,
      sourceReference: provenance === 'lifetime' ? 'matrix-ai-lifetime-starter' : 'user-authorized-main-chat-20261008-permanent-5usd' });
    await db.executor.updateTable('ai_funded_runtime_balances').set({ credit_balance_microusd: 1234,
      promotional_balance_microusd: 1234, reserved_microusd: 100, month_spent_microusd: 4_998_766,
      month_reserved_microusd: 100, funding_shortfall_microusd: 12 }).where('machine_id', '=', identity.machineId).execute();
    await db.executor.updateTable('ai_funded_promotional_grant_balances').set({ remaining_microusd: 1234 })
      .where('machine_id', '=', identity.machineId).execute();
    const before = await snapshot();
    await service.reconcileProvisioning();
    expect(await Promise.all([initialize(), initialize()])).toEqual([false, false]);
    expect(await snapshot()).toEqual(before);
  });

  it.skipIf(!process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL)('issues exactly one lifetime grant across independent native PostgreSQL pools', async () => {
    // The native fixture validates a disposable loopback URL and owns its clone.
    // No WASM fallback may stand in for independent-pool lock evidence.
    const result = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db.executor);
    const url = new URL(process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL!);
    url.pathname = `/${result.rows[0].name}`;
    secondDb = createPlatformDb({ dialect: new PostgresDialect({ pool: new pg.Pool({
      connectionString: url.href, max: 1, connectionTimeoutMillis: 2000,
      statement_timeout: 10_000, query_timeout: 12_000,
    }) }) });
    await secondDb.ready;
    const outcomes = await Promise.all([initialize(db), initialize(secondDb)]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(await ledger()).toHaveLength(1);
    expect(await policy()).toMatchObject({ revision: 1 });
    expect(await balances()).toMatchObject({ credit_balance_microusd: 5_000_000 });
    const before = await snapshot();
    expect(await Promise.all([initialize(db), initialize(secondDb)])).toEqual([false, false]);
    expect(await snapshot()).toEqual(before);
  });
});
