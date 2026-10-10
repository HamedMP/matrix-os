import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPlatformDb, type PlatformDB } from '../../packages/platform/src/db.js';
import { createPreviewDriveStore } from '../../packages/platform/src/preview-drive-store.js';

const postgresUrl = process.env.MATRIX_TEST_POSTGRES_URL;
const postgres = postgresUrl ? describe : describe.skip;

postgres('Preview Drive PostgreSQL revocation authority', () => {
  const schema = `preview_drive_test_${randomUUID().replaceAll('-', '')}`;
  const waitingApplication = `${schema}_b`;
  let admin: pg.Pool;
  let dbA: PlatformDB, dbB: PlatformDB;
  function connectionUrl(application: string) {
    const url = new URL(postgresUrl!);
    if (!url.pathname.toLowerCase().includes('test')) throw new Error('A test database is required');
    url.searchParams.set('options', `-c search_path=${schema},public -c statement_timeout=5000 -c lock_timeout=4000`);
    url.searchParams.set('application_name', application);
    return url.toString();
  }
  beforeAll(async () => {
    connectionUrl(waitingApplication);
    admin = new pg.Pool({ connectionString: postgresUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    dbA = createPlatformDb(connectionUrl(`${schema}_a`)); await dbA.ready;
    dbB = createPlatformDb(connectionUrl(waitingApplication)); await dbB.ready;
  });
  beforeEach(async () => { await dbA.executor.deleteFrom('preview_drive_grants').execute(); });
  afterAll(async () => {
    await Promise.all([dbA?.destroy(), dbB?.destroy()]);
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
  });
  async function waitForRowLock() {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const result = await admin.query<{ waiting: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'
      ) AS waiting`, [waitingApplication]);
      if (result.rows[0]?.waiting) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Concurrent run operation did not wait on the PostgreSQL row lock');
  }
  async function grants() {
    const store = createPreviewDriveStore(dbA);
    const turn = { proofNonce: 'a'.repeat(32), handle: 'pr-1234', actorId: 'user_owner',
      chatId: 'chat_one', turnId: 'cturn_one', runId: 'run_one', clientRequestId: 'req_one', bodyDigest: 'b'.repeat(64) };
    const token = (await store.redeemTurn(turn))!;
    const key = { token, handle: turn.handle, chatId: turn.chatId, runId: turn.runId };
    const action = { runGrant: token, proofNonce: 'c'.repeat(32), proofExpiresAt: Date.now() + 60_000, handle: turn.handle, actorId: turn.actorId,
      chatId: turn.chatId, runId: turn.runId, actionDigest: 'd'.repeat(64), label: 'personal', maxResults: 3,
      connectionId: 'connection-original', providerAccountId: 'provider-original' };
    const grant = (await store.issueAction(action))!;
    return { key, action, grant, turn };
  }

  it('holds run authority through an admitted provider operation before revocation commits', async () => {
    const { key, action, grant, turn } = await grants();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const work = dbA.transaction(async () => {
      expect(await createPreviewDriveStore(dbA).consumeAction({ ...action, grant })).toBeTruthy();
      entered.resolve(); await release.promise;
      return 'provider completed';
    });
    await entered.promise;
    const revoke = createPreviewDriveStore(dbB).revokeRun(key);
    try { await waitForRowLock(); } finally { release.resolve(); }
    expect(await work).toBe('provider completed');
    expect(await revoke).toBeGreaterThan(0);
    expect(await createPreviewDriveStore(dbB).getRun(key)).toBeNull();
    expect(await createPreviewDriveStore(dbB).redeemTurn(turn)).toBeNull();
  });

  it.each(['issue', 'consume', 'admit'] as const)('rejects %s that races behind a revocation transaction', async operation => {
    const { key, action, grant } = await grants();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const revoke = dbA.transaction(async () => {
      const count = await createPreviewDriveStore(dbA).revokeRun(key);
      entered.resolve(); await release.promise;
      return count;
    });
    await entered.promise;
    const store = createPreviewDriveStore(dbB);
    const pending = operation === 'issue' ? store.issueAction({ ...action, proofNonce: 'e'.repeat(32) })
      : operation === 'consume' ? store.consumeAction({ ...action, grant })
      : store.withRun(key, async () => 'must not execute');
    try { await waitForRowLock(); } finally { release.resolve(); }
    expect(await revoke).toBe(2);
    expect(await pending).toBeNull();
  });
  it('rejects an approval proof that expires behind a run row lock', async () => {
    const { key, action } = await grants();
    let now = Date.now();
    const storeA = createPreviewDriveStore(dbA, { now: () => now });
    const storeB = createPreviewDriveStore(dbB, { now: () => now });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const admitted = storeA.withRun(key, async () => { entered.resolve(); await release.promise; return true; });
    await entered.promise;
    const pending = storeB.issueAction({ ...action, proofNonce: 'e'.repeat(32), proofExpiresAt: now + 60_000 });
    try { await waitForRowLock(); now += 61_000; } finally { release.resolve(); }
    expect(await admitted).toBe(true);
    expect(await pending).toBeNull();
  });

  it('rechecks expiry after waiting for run admission', async () => {
    let now = Date.now();
    const storeA = createPreviewDriveStore(dbA, { now: () => now });
    const storeB = createPreviewDriveStore(dbB, { now: () => now });
    const token = (await storeA.redeemTurn({ proofNonce: 'a'.repeat(32), handle: 'pr-1234', actorId: 'user_owner',
      chatId: 'chat_one', turnId: 'cturn_one', runId: 'run_one', clientRequestId: 'req_one', bodyDigest: 'b'.repeat(64) }))!;
    const key = { token, handle: 'pr-1234', chatId: 'chat_one', runId: 'run_one' };
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const admitted = storeA.withRun(key, async () => { entered.resolve(); await release.promise; return true; });
    await entered.promise;
    const pending = storeB.withRun(key, async () => 'must not execute');
    try { await waitForRowLock(); now += 36 * 60_000; } finally { release.resolve(); }
    expect(await admitted).toBe(true);
    expect(await pending).toBeNull();
  });

});
