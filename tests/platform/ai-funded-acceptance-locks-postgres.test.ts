import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlatformDb, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
const databaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;
const modelId = 'anthropic/claude-sonnet-5';
describe.skipIf(!databaseUrl)('acceptance current-machine lock races on independent PostgreSQL pools', () => {
  let admin: pg.Pool;
  let db: PlatformDB;
  let writer: pg.PoolClient;
  let schema: string;
  let normal: ReturnType<typeof createAiFundedPolicyRepository>;
  let scoped: ReturnType<typeof createAiFundedPolicyRepository>;
  let identity: {
    ownerId: string;
    machineId: string;
    runtimeSlot: string;
  };
  let lease: Awaited<ReturnType<typeof normal.issueRuntimeCredential>>;
  beforeEach(async () => {
    schema = 'funded_cohort_' + randomUUID().replaceAll('-', '');
    admin = new pg.Pool({ connectionString: databaseUrl, max: 3 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    url.searchParams.set('application_name', schema);
    db = createPlatformDb(url.toString());
    await db.ready;
    identity = { ownerId: 'user_cohort_test', machineId: randomUUID(), runtimeSlot: 'pr-9999' };
    normal = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32) });
    await normal.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await insertUserMachine(db, {
      machineId: identity.machineId, clerkUserId: identity.ownerId, handle: 'cohort-test', runtimeSlot: identity.runtimeSlot, status: 'running', activationState: 'authorized', runtimeTokenEpoch: 2, imageVersion: 'test', provisionedAt: new Date().toISOString()
    });
    await normal.setRuntimePolicy({
      identity, expectedRevision: 0, enabled: true, allowedModelIds: [modelId], monthlyBudgetMicrousd: 1000, expiresAt: null
    });
    await normal.grantCredit({
      entryId: 'grant-offline', identity, kind: 'addon_grant', amountMicrousd: 1000, sourceReference: 'offline-local-test'
    });
    lease = await normal.issueRuntimeCredential(identity);
    await db.executor.updateTable('ai_funded_runtime_policies').set({ next_issue_at: '1970-01-01T00:00:00.000Z' }).where('machine_id', '=', identity.machineId).execute();
    scoped = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), acceptanceScope: { ...identity, runtimeTokenEpoch: 2, validThrough: new Date(Date.now() + 600000).toISOString() } });
    writer = await admin.connect();
    await writer.query(`SET search_path TO "${schema}"`);
  });
  afterEach(async () => {
    if (writer) {
      await writer.query('ROLLBACK');
      writer.release();
    }
    await db?.destroy();
    if (schema)
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  async function heldMutation(kind: 'epoch' | 'state') {
    await writer.query('BEGIN');
    await writer.query(kind === 'epoch' ? 'UPDATE user_machines SET runtime_token_epoch=3 WHERE machine_id=$1' : 'UPDATE user_machines SET status=$2 WHERE machine_id=$1', kind === 'epoch' ? [identity.machineId] : [identity.machineId, 'stopped']);
  }
  async function waitForBlocked() {
    await vi.waitFor(async () => {
      const blocked = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND array_length(pg_blocking_pids(pid),1)>0", [schema]);
      expect(blocked.rows[0].count).toBeGreaterThan(0);
    }, { timeout: 3000, interval: 10 });
  }
  it.each(['epoch', 'state'] as const)('issue rechecks %s after a conflicting current-machine write commits', async (kind) => {
    await heldMutation(kind);
    const pending = scoped.issueRuntimeCredential(identity).then(value => ({ value }), error => ({ error }));
    await waitForBlocked();
    await writer.query('COMMIT');
    expect(await pending).toHaveProperty('error');
    expect(await db.executor.selectFrom('ai_runtime_credentials').selectAll().execute()).toHaveLength(1);
    expect((await db.executor.selectFrom('ai_funded_runtime_policies').select('next_issue_at').executeTakeFirstOrThrow()).next_issue_at).toBe('1970-01-01T00:00:00.000Z');
  });
  it.each(['epoch', 'state'] as const)('authorize rechecks %s under the held machine row before monetary writes', async (kind) => {
    await heldMutation(kind);
    const pending = scoped.authorize({
      credential: lease.credential.token, requestId: 'race-auth', modelId, maxCostMicrousd: 100, billingMode: 'usage'
    }).then(value => ({ value }), error => ({ error }));
    await waitForBlocked();
    await writer.query('COMMIT');
    expect(await pending).toHaveProperty('error');
    expect(await db.executor.selectFrom('ai_funded_usage_reservations').selectAll().execute()).toEqual([]);
    expect(Number((await db.executor.selectFrom('ai_funded_runtime_balances').select('reserved_microusd').executeTakeFirstOrThrow()).reserved_microusd)).toBe(0);
  });
  it.each(['epoch', 'state'] as const)('new start rechecks %s without changing an existing reserved obligation', async (kind) => {
    const authorized = await scoped.authorize({
      credential: lease.credential.token, requestId: 'race-start', modelId, maxCostMicrousd: 100, billingMode: 'usage'
    });
    await heldMutation(kind);
    const pending = scoped.startReservation({ reservationId: authorized.reservation.reservationId, tokenId: lease.credential.tokenId }).then(value => ({ value }), error => ({ error }));
    await waitForBlocked();
    await writer.query('COMMIT');
    expect(await pending).toHaveProperty('error');
    expect((await db.executor.selectFrom('ai_funded_usage_reservations').select(['status', 'start_response']).executeTakeFirstOrThrow())).toEqual({ status: 'reserved', start_response: null });
  });
  it.each(['issue', 'authorize', 'start'] as const)('%s rolls back new work when the absolute deadline passes during a machine lock wait', async (action) => {
    const authorized = action === 'start' ? await normal.authorize({
      credential: lease.credential.token, requestId: 'expiry-start', modelId, maxCostMicrousd: 100, billingMode: 'usage'
    }) : undefined;
    const validThrough = new Date(Date.now() + 2000).toISOString();
    scoped = createAiFundedPolicyRepository({ db, credentialHashSecret: 'h'.repeat(32), acceptanceScope: { ...identity, runtimeTokenEpoch: 2, validThrough } });
    await writer.query('BEGIN');
    await writer.query('SELECT machine_id FROM user_machines WHERE machine_id=$1 FOR UPDATE', [identity.machineId]);
    const operation = action === 'issue' ? scoped.issueRuntimeCredential(identity) : action === 'authorize' ? scoped.authorize({
      credential: lease.credential.token, requestId: 'expiry-auth', modelId, maxCostMicrousd: 100, billingMode: 'usage'
    }) : scoped.startReservation({ reservationId: authorized!.reservation.reservationId, tokenId: lease.credential.tokenId });
    const pending = operation.then(value => ({ value }), error => ({ error }));
    await waitForBlocked();
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(validThrough)), { timeout: 3000, interval: 25 });
    await writer.query('COMMIT');
    expect(await pending).toMatchObject({ error: { code: 'access_disabled' } });
    expect(await db.executor.selectFrom('ai_runtime_credentials').selectAll().execute()).toHaveLength(1);
    const reservations = await db.executor.selectFrom('ai_funded_usage_reservations').select(['status', 'start_response']).execute();
    expect(reservations).toEqual(action === 'start' ? [{ status: 'reserved', start_response: null }] : []);
    expect((await db.executor.selectFrom('ai_funded_runtime_policies').select('next_issue_at').executeTakeFirstOrThrow()).next_issue_at).toBe('1970-01-01T00:00:00.000Z');
  });
});
