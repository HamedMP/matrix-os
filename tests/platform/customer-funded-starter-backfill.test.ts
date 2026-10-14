import { createHash, randomUUID } from 'node:crypto';
import { PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { initializeCustomerFundedStarterPolicy, lockCustomerFundedStarterActivation } from '../../packages/platform/src/customer-funded-starter-policy.js';
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

// Hosted funded CI provides a disposable service; dedicated CI supplies the
// existing native clone helper. Never point this schema fixture at owner data.
function hostedTestUrl(): URL | undefined {
  if (process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL || !process.env.MATRIX_TEST_POSTGRES_URL) return undefined;
  const url = new URL(process.env.MATRIX_TEST_POSTGRES_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.pathname !== '/matrix_test' || url.search || url.hash) throw new Error('Starter recovery requires the disposable loopback test service');
  return url;
}

describe('ENG-291 completed customer starter recovery', () => {
  let db: PlatformDB;
  let secondDb: PlatformDB | undefined;
  let service: ReturnType<typeof createCustomerVpsService>;
  let repository: ReturnType<typeof createAiFundedPolicyRepository>;
  let admin: pg.Pool | undefined;
  let schema: string | undefined;
  const serviceFor = (target: PlatformDB) => createCustomerVpsService({ db: target,
    config: loadCustomerVpsConfig({ PLATFORM_SECRET: 'fixture-platform', HETZNER_API_TOKEN: 'fixture-hetzner',
      S3_ACCESS_KEY_ID: 'fixture-r2', S3_SECRET_ACCESS_KEY: 'fixture-r2-secret',
      S3_ENDPOINT: 'https://r2.example', R2_BUCKET: 'fixture', CUSTOMER_VPS_RECONCILIATION_BATCH_SIZE: '1' }),
    hetzner: createMockHetznerClient(), systemStore: createMockCustomerVpsSystemStore(), now: () => new Date(now) });

  beforeEach(async () => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const url = hostedTestUrl();
    if (url) {
      schema = `starter_backfill_${randomUUID().replaceAll('-', '')}`;
      admin = new pg.Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 2000,
        statement_timeout: 10_000, query_timeout: 12_000 });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      url.searchParams.set('options', `-c search_path=${schema}`);
      db = createPlatformDb({ dialect: new PostgresDialect({ pool: new pg.Pool({
        connectionString: url.href, max: 1, connectionTimeoutMillis: 2000,
        statement_timeout: 10_000, query_timeout: 12_000,
        types: { getTypeParser: (oid, format = 'text') => oid === pg.types.builtins.INT8 && format === 'text'
          ? (value: string) => { const n = BigInt(value); return n >= Number.MIN_SAFE_INTEGER && n <= Number.MAX_SAFE_INTEGER ? Number(n) : n; }
          : pg.types.getTypeParser(oid, format) },
      }) }) });
      await db.ready;
    } else ({ db } = await createTestPlatformDb());
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
    service = serviceFor(db);
  });

  afterEach(async () => {
    try { await secondDb?.destroy(); }
    finally {
      secondDb = undefined;
      try { await destroyTestPlatformDb(db); }
      finally {
        try {
          if (admin && schema) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        } finally {
          try { await admin?.end(); }
          finally { admin = undefined; schema = undefined; vi.unstubAllEnvs(); vi.restoreAllMocks(); }
        }
      }
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

  it('automatically reconciles an eligible owner whose activation completed before rollout', async () => {
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

  it('bounds each pass and advances past an opt-out without starving another historical owner', async () => {
    await repository.setRuntimePolicy({ identity, expectedRevision: 0, enabled: false,
      allowedModelIds: [modelId], monthlyBudgetMicrousd: 5_000_000, expiresAt: null });
    const otherMachine = 'af05824c-8d0a-4d83-9cb4-b312d43ff112';
    await insertUserMachine(db, { machineId: otherMachine, clerkUserId: 'other-backfill-owner', handle: 'other-backfill',
      runtimeSlot: 'primary', provisioningClass: 'customer', activationState: 'authorized', status: 'running',
      imageVersion: 'reviewed-fixture', provisionedAt: activatedAt, activationAuthorizedAt: activatedAt,
      hetznerServerId: 123457, publicIPv4: '203.0.113.11' });
    await service.reconcileProvisioning();
    expect(await ledger()).toEqual([]);
    expect(await db.executor.selectFrom('ai_funded_runtime_policies').selectAll()
      .where('machine_id', '=', otherMachine).execute()).toEqual([]);
    await service.reconcileProvisioning();
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll()
      .where('owner_id', '=', 'other-backfill-owner').execute()).toHaveLength(1);
    await service.reconcileProvisioning(); // End of keyset traversal resets the cursor.
    await service.reconcileProvisioning();
    expect(await policy()).toMatchObject({ enabled: false });
    expect(await ledger()).toEqual([]);
  });

  it.each(['2026-10-12T17:00:25Z', '2026-10-13T18:00:00Z', 'not-a-time'])('excludes newer or unreadable activation evidence: %s', async time => {
    await db.executor.updateTable('user_machines').set({ activation_authorized_at: time })
      .where('machine_id', '=', identity.machineId).execute();
    await service.reconcileProvisioning();
    expect(await snapshot()).toEqual({ policy: undefined, ledger: [], balance: undefined, grants: [] });
  });

  it('recovers legacy completed owners without an activation timestamp using old provisioning evidence', async () => {
    await db.executor.updateTable('user_machines').set({ activation_authorized_at: null })
      .where('machine_id', '=', identity.machineId).execute();
    await service.reconcileProvisioning();
    expect(await ledger()).toHaveLength(1);
  });

  it('bounds lock admission before the first owner lock without changing later transactions', async () => {
    const baseline = await sql<{ timeout: string }>`SELECT current_setting('lock_timeout') AS timeout`.execute(db.executor);
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce(work => transaction(async trx => {
      const nested = trx.transaction.bind(trx);
      vi.spyOn(trx, 'transaction').mockImplementationOnce(async innerWork => {
        // Admission's first nested transaction is entered before its owner lock.
        const setting = await sql<{ timeout: string }>`SELECT current_setting('lock_timeout') AS timeout`.execute(trx.executor);
        expect(parseFloat(setting.rows[0].timeout)).toBeGreaterThan(0);
        expect(parseFloat(setting.rows[0].timeout)).toBeLessThanOrEqual(250);
        return nested(innerWork);
      });
      return work(trx);
    }));
    await service.reconcileProvisioning();
    expect(await ledger()).toHaveLength(1);
    expect(await sql<{ timeout: string }>`SELECT current_setting('lock_timeout') AS timeout`.execute(db.executor)).toEqual(baseline);
  });

  it.each([
    { clerk_user_id: 'replacement-owner' }, { activation_authorized_at: now },
    { status: 'failed' as const }, { deleted_at: now },
  ])('rechecks identity/cohort/eligibility when the sampled machine changes: %j', async changes => {
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, 'transaction').mockImplementationOnce(async work => {
      await db.executor.updateTable('user_machines').set(changes).where('machine_id', '=', identity.machineId).execute();
      return transaction(work);
    });
    await service.reconcileProvisioning();
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toEqual([]);
    expect(await db.executor.selectFrom('ai_funded_runtime_policies').selectAll().execute()).toEqual([]);
  });

  it('blocks deletion-pending owners and retries after cancellation without duplicate credit', async () => {
    const secret = 'starter-backfill-deletion-secret-32-bytes';
    vi.stubEnv('ACCOUNT_DELETION_SECRET', secret);
    const deletion = new AccountDeletionRepository(db.kysely, { secret, now: () => new Date(now) });
    await deletion.accept({ clerkUserId: identity.ownerId, appleTokens: [] }, false);
    const receipt = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await service.reconcileProvisioning();
    expect(await ledger()).toEqual([]);
    expect(receipt).toHaveBeenCalledWith(expect.stringContaining('"outcome":"deletion_pending"'));
    await db.executor.updateTable('account_deletion_jobs').set({ status: 'cancelled' }).execute();
    await service.reconcileProvisioning(); // Reset exhausted page cursor.
    await service.reconcileProvisioning();
    expect(await ledger()).toHaveLength(1);
  });

  it('preserves conflicting grant evidence and continues the next bounded page', async () => {
    await repository.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true,
      allowedModelIds: [modelId], monthlyBudgetMicrousd: 5_000_000, expiresAt: null });
    await repository.grantCredit({ identity, entryId: 'manual-main-chat-20261008-permanent-5usd:conflict',
      kind: 'promotional_grant', amountMicrousd: 4_000_000, expiresAt: null,
      sourceReference: 'user-authorized-main-chat-20261008-permanent-5usd' });
    const before = await snapshot();
    await insertUserMachine(db, { machineId: 'af05824c-8d0a-4d83-9cb4-b312d43ff112', clerkUserId: 'other-backfill-owner',
      handle: 'other-backfill', runtimeSlot: 'primary', provisioningClass: 'customer', activationState: 'authorized',
      status: 'running', imageVersion: 'reviewed-fixture', provisionedAt: activatedAt, activationAuthorizedAt: activatedAt,
      hetznerServerId: 123457, publicIPv4: '203.0.113.11' });
    const receipt = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    await service.reconcileProvisioning();
    expect(await snapshot()).toEqual(before);
    expect(receipt).toHaveBeenCalledWith(expect.stringContaining('"outcome":"initialization_failed"'));
    await service.reconcileProvisioning();
    expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll()
      .where('owner_id', '=', 'other-backfill-owner').execute()).toHaveLength(1);
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

  const openSecondPool = async () => {
    // The native fixture validates a disposable loopback URL and owns its clone.
    // No WASM fallback may stand in for independent-pool lock evidence.
    const result = await sql<{ name: string }>`SELECT current_database() AS name`.execute(db.executor);
    const url = new URL((process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL ?? process.env.MATRIX_TEST_POSTGRES_URL)!);
    url.pathname = `/${result.rows[0].name}`;
    if (schema) url.searchParams.set('options', `-c search_path=${schema}`);
    secondDb = createPlatformDb({ dialect: new PostgresDialect({ pool: new pg.Pool({
      connectionString: url.href, max: 1, connectionTimeoutMillis: 2000,
      statement_timeout: 10_000, query_timeout: 12_000,
    }) }) });
    await secondDb.ready;
    return secondDb;
  };

  it.skipIf(!process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL && !process.env.MATRIX_TEST_POSTGRES_URL)('skips a busy owner within a bounded pass and retries after its native lock is released', async () => {
    const contender = serviceFor(await openSecondPool());
    await db.transaction(async trx => {
      await lockCustomerFundedStarterActivation(trx, identity.ownerId, env);
      const started = Date.now();
      await contender.reconcileProvisioning();
      expect(Date.now() - started).toBeLessThan(2000);
      expect(await trx.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toEqual([]);
    });
    await contender.reconcileProvisioning(); // Cursor reset.
    await contender.reconcileProvisioning();
    expect(await ledger()).toHaveLength(1);
  });

  it.skipIf(!process.env.MATRIX_PLATFORM_FIXTURE_POSTGRES_URL && !process.env.MATRIX_TEST_POSTGRES_URL)('issues exactly one lifetime grant across independent native PostgreSQL pools', async () => {
    await openSecondPool();
    let pending: Promise<boolean> | undefined;
    let firstChanged = false;
    try {
      await db.transaction(async trx => {
        firstChanged = await initialize(trx);
        pending = initialize(secondDb!);
        // Observe a real waiter for this exact owner lock, not timing alone.
        await vi.waitFor(async () => {
          const waiting = await sql<{ count: number }>`SELECT count(*)::int AS count
            FROM pg_locks AS waiting JOIN pg_locks AS held
              ON waiting.locktype = held.locktype AND waiting.database = held.database
              AND waiting.classid = held.classid AND waiting.objid = held.objid AND waiting.objsubid = held.objsubid
            WHERE waiting.locktype = 'advisory' AND NOT waiting.granted
              AND held.granted AND held.pid = pg_backend_pid()`.execute(trx.executor);
          expect(waiting.rows[0].count).toBeGreaterThan(0);
        }, { timeout: 3000, interval: 25 });
      });
      expect(firstChanged).toBe(true);
      expect(await pending).toBe(false);
    } finally {
      // Release the first transaction before draining an unsuccessful contender.
      if (pending) await pending.catch(error => {
        console.error('[starter-backfill-test] contender failed:', error instanceof Error ? error.name : 'UnknownError');
      });
    }
    expect(await ledger()).toHaveLength(1);
    expect(await policy()).toMatchObject({ revision: 1 });
    expect(await balances()).toMatchObject({ credit_balance_microusd: 5_000_000 });
    const before = await snapshot();
    expect(await Promise.all([initialize(db), initialize(secondDb)])).toEqual([false, false]);
    expect(await snapshot()).toEqual(before);
  });
});
