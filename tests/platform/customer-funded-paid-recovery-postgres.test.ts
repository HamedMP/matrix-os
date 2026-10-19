import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlatformDb, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { lockCustomerFundedStarterActivation } from '../../packages/platform/src/customer-funded-starter-policy.js';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { at, env, financialSnapshot, lifetimeId, model, recoveryApi, review, seed, sourceSha,
  type Api, type Recover, type Target } from './paid-starter-recovery-fixture.js';

// Required dedicated GitHub job supplies only its disposable PostgreSQL service.
const databaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;
describe.skipIf(!databaseUrl)('paid starter recovery on independent PostgreSQL connections', () => {
  let api: Api; let db: PlatformDB; let second: PlatformDB; let admin: pg.Pool;
  let schema: string; let targets: Target[]; let recover: Recover; let clock: Date;
  beforeAll(async () => { api = await recoveryApi(); });
  beforeEach(async () => {
    schema = `paid_recovery_${randomUUID().replaceAll('-', '')}`;
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!); url.searchParams.set('options', `-c search_path=${schema}`);
    db = createPlatformDb(url.toString()); await db.ready;
    url.searchParams.set('application_name', `${schema}_second`);
    second = createPlatformDb(url.toString()); await second.ready;
    targets = await seed(db); clock = new Date(at);
    recover = api.createPaidStarterRecovery({ db, env, sourceSha, now: () => new Date(clock) });
  });
  afterEach(async () => {
    await second?.destroy(); await db?.destroy();
    if (schema && admin) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  async function waitForBlockedQuery() {
    await vi.waitFor(async () => {
      const waiting = await admin.query<{ count: number }>(`SELECT count(*)::int AS count
        FROM pg_locks lock JOIN pg_stat_activity activity ON activity.pid=lock.pid
        WHERE NOT lock.granted AND activity.application_name=$1`, [`${schema}_second`]);
      expect(waiting.rows[0].count).toBeGreaterThan(0);
    }, { timeout: 3000, interval: 25 });
  }
  it('concurrent reviewed apply commits at most one grant per owner without refill', async () => {
    const input = review(targets); const prepared = await recover(input);
    const other = api.createPaidStarterRecovery({ db: second, env, sourceSha, now: () => new Date(clock) });
    const outcomes = await Promise.allSettled([recover(input, { apply: true, reviewedFingerprint: prepared.fingerprint }),
      other(input, { apply: true, reviewedFingerprint: prepared.fingerprint })]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
    const ledger = await db.executor.selectFrom('ai_funded_credit_ledger').selectAll()
      .where('source_reference', '=', 'matrix-ai-lifetime-starter').execute();
    expect(ledger.map(row => row.entry_id).sort()).toEqual(targets.map(target => lifetimeId(target.ownerId)).sort());
    expect(ledger.every(row => Number(row.amount_microusd) === 5_000_000)).toBe(true);
  }, 30_000);
  it('atomically admits the explicit disabled namespace only with matched serving authority and zero global jobs', async () => {
    const authority = { servingRevision: 'matrix-platform-fixture-reviewed', imageDigest: `sha256:${'c'.repeat(64)}` };
    const actualEnv: NodeJS.ProcessEnv = { ...env, ACCOUNT_DELETION_ENABLED: 'false',
      MATRIX_PAID_STARTER_RECOVERY_PLATFORM_REVISION: authority.servingRevision,
      MATRIX_PAID_STARTER_RECOVERY_PLATFORM_IMAGE_DIGEST: authority.imageDigest };
    delete actualEnv.ACCOUNT_DELETION_SECRET;
    const disabled = api.createPaidStarterRecovery({ db, env: actualEnv, sourceSha, now: () => new Date(clock) });
    const input = { ...review(targets), accountDeletionMode: 'disabled' as const, disabledDeletionAuthority: authority };
    const before = await financialSnapshot(db); const prepared = await disabled(input);
    expect(await financialSnapshot(db)).toEqual(before);
    expect(await disabled(input, { apply: true, reviewedFingerprint: prepared.fingerprint }))
      .toMatchObject({ mode: 'applied', targetCount: 3, grantedMicrousd: 15_000_000 });
    const after = await financialSnapshot(db);
    expect(after.ledger.filter(row => row.source_reference === 'matrix-ai-lifetime-starter')).toHaveLength(3);
    expect(after.grants.filter(row => row.grant_entry_id.startsWith('speech-monthly:'))).toEqual(before.grants);
    expect(after.speechAllowances).toEqual(before.speechAllowances);
  });
  it('shares deletion/funding owner admission before taking machine locks', async () => {
    const input = review(targets); const prepared = await recover(input);
    const other = api.createPaidStarterRecovery({ db: second, env, sourceSha, now: () => new Date(clock) });
    let applying: ReturnType<Recover> | undefined;
    try {
      await db.transaction(async trx => {
        await lockCustomerFundedStarterActivation(trx, targets[0].ownerId, env);
        applying = other(input, { apply: true, reviewedFingerprint: prepared.fingerprint });
        await waitForBlockedQuery();
        await trx.executor.selectFrom('user_machines').select('machine_id')
          .where('machine_id', '=', targets[0].machineId).forUpdate().noWait().executeTakeFirstOrThrow();
      });
      await expect(applying).resolves.toMatchObject({ mode: 'applied', grantedMicrousd: 15_000_000 });
    } finally { await applying?.catch(() => undefined); }
  }, 30_000);
  it('rechecks expiry after waiting for admission rather than using a frozen pre-request clock', async () => {
    const input = review(targets); const prepared = await recover(input); const before = await financialSnapshot(db);
    const other = api.createPaidStarterRecovery({ db: second, env, sourceSha, now: () => new Date(clock) });
    let applying: ReturnType<Recover> | undefined;
    try {
      await db.transaction(async trx => {
        await lockCustomerFundedStarterActivation(trx, targets[0].ownerId, env);
        applying = other(input, { apply: true, reviewedFingerprint: prepared.fingerprint });
        // Attach rejection handling while the independent transaction is blocked.
        void applying.catch(() => undefined);
        await waitForBlockedQuery(); clock = new Date(input.expiresAt);
      });
      await expect(applying).rejects.toThrow();
      expect(await financialSnapshot(db)).toEqual(before);
    } finally { await applying?.catch(() => undefined); }
  }, 30_000);
  it('fresh locked billing state defeats a stale paid preflight without partial grants', async () => {
    const input = review(targets); const prepared = await recover(input); const before = await financialSnapshot(db);
    const other = api.createPaidStarterRecovery({ db: second, env, sourceSha, now: () => new Date(clock) });
    let applying: ReturnType<Recover> | undefined;
    try {
      await db.transaction(async trx => {
        await trx.executor.selectFrom('billing_subscriptions').select('stripe_subscription_id')
          .where('stripe_subscription_id', '=', targets[0].expectedSubscriptionId).forUpdate().executeTakeFirstOrThrow();
        applying = other(input, { apply: true, reviewedFingerprint: prepared.fingerprint });
        void applying.catch(() => undefined); await waitForBlockedQuery();
        await trx.executor.updateTable('billing_subscriptions').set({ status: 'past_due', trial_converted_at: null,
          first_trial_payment_failed_at: at }).where('stripe_subscription_id', '=', targets[0].expectedSubscriptionId).execute();
      });
      await expect(applying).rejects.toThrow();
      expect(await financialSnapshot(db)).toEqual(before);
    } finally { await applying?.catch(() => undefined); }
  }, 30_000);
  it('sees deletion committed while waiting for the actual deletion owner admission lock', async () => {
    const input = review(targets); const prepared = await recover(input); const before = await financialSnapshot(db);
    const other = api.createPaidStarterRecovery({ db: second, env, sourceSha, now: () => new Date(clock) });
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const holding = new Promise<void>(resolve => { entered = resolve; });
    const deletion = new AccountDeletionRepository(db.kysely, { secret: env.ACCOUNT_DELETION_SECRET, now: () => new Date(clock) });
    // acceptPrepared acquires the real owner lock before invoking preparation
    // and inserts the job only after it resolves. Recovery has already started
    // its transaction while waiting, exposing stale repeatable/SSI admission.
    const accepting = deletion.acceptPrepared(targets[0].ownerId, false, async () => {
      entered(); await gate; return { clerkUserId: targets[0].ownerId, appleTokens: [] };
    });
    await holding;
    const applying = other(input, { apply: true, reviewedFingerprint: prepared.fingerprint });
    void applying.catch(() => undefined);
    try {
      await waitForBlockedQuery(); release();
      await expect(accepting).resolves.toMatchObject({ status: 'scheduled' });
      await expect(applying).rejects.toThrow();
      expect(await financialSnapshot(db)).toEqual(before);
    } finally { release(); await Promise.allSettled([accepting, applying]); }
  }, 30_000);
  it.each(['paid period', 'speech allocation'] as const)
    ('does not grant or retire speech when %s expires during the final global-policy lock wait', async expiry => {
    const expiresAt = '2026-10-16T14:00:01.000Z';
    if (expiry === 'paid period') {
      await db.executor.updateTable('billing_subscriptions').set({ current_period_end: expiresAt })
        .where('stripe_subscription_id', '=', targets[0].expectedSubscriptionId).execute();
    } else {
      await db.executor.updateTable('ai_funded_promotional_grant_balances').set({ expires_at: expiresAt })
        .where('owner_id', '=', targets[0].ownerId).execute();
      await db.executor.updateTable('ai_funded_credit_ledger').set({ expires_at: expiresAt })
        .where('owner_id', '=', targets[0].ownerId).execute();
    }
    const input = review(targets); const prepared = await recover(input); const before = await financialSnapshot(db);
    const other = api.createPaidStarterRecovery({ db: second, env, sourceSha, now: () => new Date(clock) });
    let applying: ReturnType<Recover> | undefined;
    try {
      await db.transaction(async trx => {
        await trx.executor.selectFrom('ai_funded_global_policy').select('policy_id')
          .where('policy_id', '=', 'default').forUpdate().executeTakeFirstOrThrow();
        applying = other(input, { apply: true, reviewedFingerprint: prepared.fingerprint });
        void applying.catch(() => undefined); await waitForBlockedQuery();
        clock = new Date('2026-10-16T14:00:02.000Z');
      });
      await expect(applying).rejects.toThrow(); expect(await financialSnapshot(db)).toEqual(before);
    } finally { await applying?.catch(() => undefined); }
  }, 30_000);
  it('rolls back all policy, balance and grants if the shared initializer fails after policy insertion', async () => {
    const input = review(targets); const prepared = await recover(input); const before = await financialSnapshot(db);
    await admin.query(`CREATE FUNCTION "${schema}".reject_recovery_grant() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.source_reference='matrix-ai-lifetime-starter' THEN RAISE EXCEPTION 'fixture rollback'; END IF;
      RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER reject_recovery_grant BEFORE INSERT ON "${schema}".ai_funded_credit_ledger
      FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_recovery_grant()`);
    await expect(recover(input, { apply: true, reviewedFingerprint: prepared.fingerprint })).rejects.toThrow();
    expect(await financialSnapshot(db)).toEqual(before);
  });
  it('owner-wide prior general provenance on another runtime forbids a replacement starter', async () => {
    const target = targets[0]; const otherId = randomUUID();
    await insertUserMachine(db, { machineId: otherId, clerkUserId: target.ownerId, handle: 'fixture-secondary',
      runtimeSlot: 'secondary', provisioningClass: 'customer', activationState: 'authorized', status: 'running',
      imageVersion: 'fixture', provisionedAt: at });
    await db.executor.insertInto('ai_funded_runtime_balances').values({ machine_id: otherId, owner_id: target.ownerId,
      runtime_slot: 'secondary', credit_balance_microusd: 0, promotional_balance_microusd: 0, addon_balance_microusd: 0,
      reserved_microusd: 0, funding_shortfall_microusd: 0, month_period_start: at,
      month_spent_microusd: 0, month_reserved_microusd: 0, updated_at: at }).execute();
    const repo = createAiFundedPolicyRepository({ db, credentialHashSecret: env.AI_FUNDED_CREDENTIAL_HASH_SECRET, now: () => new Date(at) });
    await repo.grantCredit({ identity: { ownerId: target.ownerId, machineId: otherId, runtimeSlot: 'secondary' },
      entryId: 'fixture_other_runtime_spent', kind: 'promotional_grant', amountMicrousd: 5_000_000,
      sourceReference: 'fixture-prior-general', expiresAt: null });
    await db.executor.updateTable('ai_funded_promotional_grant_balances').set({ remaining_microusd: 0 })
      .where('grant_entry_id', '=', 'fixture_other_runtime_spent').execute();
    const before = await financialSnapshot(db);
    await expect(recover(review(targets))).rejects.toThrow();
    expect(await financialSnapshot(db)).toEqual(before);
  });
  it('rejects an unresolved exact owner usage row despite a zero aggregate reserved balance', async () => {
    const target = targets[2];
    // Fixture-only minimal durable row; the product recovery may never manufacture one.
    await sql`INSERT INTO ai_runtime_credentials
      (token_id,token_hash,owner_id,machine_id,runtime_slot,audience,scope,issued_at,expires_at)
      VALUES ('fixture_token',${'c'.repeat(64)},${target.ownerId},${target.machineId},'primary',
       'matrix-funded-relay','ai:invoke',${at},'2026-10-16T15:00:00.000Z')`.execute(db.executor);
    await sql`INSERT INTO ai_funded_usage_reservations
      (reservation_id,request_id,payload_hash,authorization_response,token_id,owner_id,machine_id,runtime_slot,
       model_id,reserved_microusd,period_start,status,created_at,expires_at,started_at)
      VALUES ('fixture_unknown','fixture_request',${'d'.repeat(64)},'{}','fixture_token',${target.ownerId},
       ${target.machineId},'primary',${model},1,${at},'in_flight',${at},${at},${at})`.execute(db.executor);
    const before = await financialSnapshot(db);
    await expect(recover(review(targets))).rejects.toThrow();
    expect(await financialSnapshot(db)).toEqual(before);
  });
});
