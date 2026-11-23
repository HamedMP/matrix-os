import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountDeletionRepository, hashAccountDeletionOwner } from '../../packages/platform/src/account-deletion/repository.js';
import { createAiFundedPolicyRepository } from '../../packages/platform/src/ai-funded-policy-repository.js';
import { createPlatformDb, insertContainer, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createInternalSyncRoutes } from '../../packages/platform/src/internal-sync-routes.js';
import { lockBillingOwner } from '../../packages/platform/src/billing/owner-lock.js';
import { withAccountDeletionOwnerLock } from '../../packages/platform/src/account-deletion/admission.js';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';

const databaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;
const secret = 'local-storage-funded-lock-regression-secret';
const platformSecret = 'local-platform-secret';
const identity = { ownerId: 'user_storage_funded_lock', machineId: 'storage_funded_machine', runtimeSlot: 'primary' };
const handle = 'storage-funded-lock';
const modelId = '@cf/zai-org/glm-5.3';
const now = new Date('2026-11-19T10:00:00.000Z');
type StorageKind = 'read' | 'write' | 'object-read' | 'object-write';

describe.skipIf(!databaseUrl)('funded admission during authenticated storage on independent PostgreSQL pools', () => {
  let fixture: PlatformDB | undefined, storageDb: PlatformDB, fundingDb: PlatformDB, deletionDb: PlatformDB;
  let admin: pg.Pool, app: Hono, funding: ReturnType<typeof createAiFundedPolicyRepository>, token: string;
  let fundingName: string, deletionName: string, fixtureDatabase: string, schema: string;
  let entered: ReturnType<typeof Promise.withResolvers<void>>, release: ReturnType<typeof Promise.withResolvers<void>>;
  let pending: Promise<unknown>[], storageCalls: number, storageFailure: 'error' | 'abort' | undefined;
  const headers = { authorization: `Bearer ${buildPlatformVerificationToken(handle, platformSecret)}`, 'content-type': 'application/json' };

  beforeEach(async () => {
    vi.stubEnv('ACCOUNT_DELETION_SECRET', secret);
    entered = Promise.withResolvers<void>(); release = Promise.withResolvers<void>(); pending = []; storageCalls = 0; storageFailure = undefined;
    const url = new URL(databaseUrl!);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || !url.pathname.endsWith('_test') || url.search || url.hash) {
      throw Error('A literal-loopback disposable _test PostgreSQL fixture is required');
    }
    fixtureDatabase = url.pathname.slice(1);
    schema = `sync_funded_${randomUUID().replaceAll('-', '')}`;
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 2000, statement_timeout: 2000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set('options', `-c search_path=${schema},public`);
    const make = (suffix: string) => {
      url.searchParams.set('application_name', `${schema}_${suffix}`);
      return createPlatformDb(url.href);
    };
    storageDb = make('storage'); fundingDb = make('funding'); deletionDb = make('deletion');
    fundingName = `${schema}_funding`; deletionName = `${schema}_deletion`;
    await Promise.all([storageDb.ready, fundingDb.ready, deletionDb.ready]);
    fixture = storageDb;
    await insertContainer(fixture, { handle, clerkUserId: identity.ownerId, status: 'running', port: 4000, shellPort: 3000 });
    await insertUserMachine(fixture, { machineId: identity.machineId, clerkUserId: identity.ownerId, handle, runtimeSlot: identity.runtimeSlot,
      status: 'running', activationState: 'authorized', provisioningClass: 'customer', imageVersion: 'test', provisionedAt: now.toISOString() });
    funding = createAiFundedPolicyRepository({ db: fundingDb, credentialHashSecret: 'h'.repeat(32), now: () => new Date(now) });
    await funding.updateGlobalPolicy({ expectedRevision: 0, enabled: true, allowedModelIds: [modelId] });
    await funding.setRuntimePolicy({ identity, expectedRevision: 0, enabled: true, allowedModelIds: [modelId], monthlyBudgetMicrousd: 1000, expiresAt: null });
    await funding.grantCredit({ identity, entryId: 'storage_lock_credit', kind: 'promotional_grant', amountMicrousd: 1000, sourceReference: 'local-test' });
    token = (await funding.issueRuntimeCredential(identity)).credential.token;
    const r2 = {
      getPresignedGetUrl: vi.fn(async () => 'https://storage.example/get'),
      getPresignedPutUrl: vi.fn(async () => { storageCalls++; entered.resolve(); await release.promise; return 'https://storage.example/put'; }),
      headObject: vi.fn(async () => { storageCalls++; entered.resolve(); await release.promise;
        if (storageFailure) throw storageFailure === 'abort' ? new DOMException('synthetic abort', 'AbortError') : new Error('synthetic object failure');
        return { exists: true }; }),
      createMultipartUpload: vi.fn(async () => 'upload'), getPresignedPartUrl: vi.fn(async () => 'https://storage.example/part'),
      getObject: vi.fn(async () => { storageCalls++; entered.resolve(); await release.promise;
        return { body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } }) }; }),
      putObject: vi.fn(async () => { storageCalls++; entered.resolve(); await release.promise; return { etag: 'etag' }; }),
      deleteObject: vi.fn(async () => {}), completeMultipartUpload: vi.fn(async () => ({})),
      abortMultipartUpload: vi.fn(async () => {}), listMultipartUploads: vi.fn(async () => []),
    };
    app = new Hono().route('/internal/containers/:handle/sync', createInternalSyncRoutes({ db: storageDb, r2, platformSecret, r2PrefixRoot: 'matrixos-sync' }));
  });

  afterEach(async () => {
    release?.resolve(); await Promise.allSettled(pending ?? []);
    vi.unstubAllEnvs();
    await Promise.all([storageDb?.destroy(), fundingDb?.destroy(), deletionDb?.destroy()]);
    if (schema) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end(); fixture = undefined;
  });

  function startStorage(kind: StorageKind) {
    const object = kind.startsWith('object-');
    const key = `matrixos-sync/${identity.ownerId}/files/test.txt`;
    const path = object ? '/object?key=' + encodeURIComponent(key) : kind === 'read' ? '/system/exists' : '/presign/put';
    const request = app.request(`/internal/containers/${handle}/sync${path}`, {
      method: object ? kind === 'object-read' ? 'GET' : 'PUT' : 'POST', headers,
      ...(kind === 'object-read' ? {} : { body: object ? 'test-object-bytes' : JSON.stringify(kind === 'read' ? { key: 'system/db/latest' } : { key, size: 1 }) }),
    });
    pending.push(request); return request;
  }
  function authorize() {
    const request = funding.authorize({ credential: token, requestId: 'storage_lock_authorization', modelId,
      maxCostMicrousd: 27, billingMode: 'usage', billingPolicy: 'postpaid' });
    pending.push(request); return request;
  }
  async function waitForOwnerBlock(applicationName: string, cancelled: () => boolean,
    scope: string | null = 'account-deletion:' + hashAccountDeletionOwner(identity.ownerId, secret)) {
    for (let i = 0; i < 100; i++) {
      if (cancelled()) return 'observation_cancelled';
      const result = await admin.query<{ waiting: boolean }>(`SELECT EXISTS (
       SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
       WHERE a.application_name=$1 AND l.locktype='advisory' AND NOT l.granted AND l.objsubid=1
        AND l.database=(SELECT oid FROM pg_database WHERE datname=$2)
        AND ($3::text IS NULL OR (l.classid=((hashtextextended($3,0)>>32)&4294967295)::oid
        AND l.objid=(hashtextextended($3,0)&4294967295)::oid))
      ) AS waiting`, [applicationName, fixtureDatabase, scope]);
      if (result.rows[0].waiting) return scope?.startsWith('account-deletion:') ? 'blocked_by_account_deletion_lock' : 'blocked_by_owner_lock';
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return 'observation_deadline';
  }

  async function observeCompetition<T>(work: Promise<T>, applicationName: string, completed: string, scope?: string | null) {
    let cancelled = false;
    const observation = waitForOwnerBlock(applicationName, () => cancelled, scope);
    try { return await Promise.race([work.then(() => completed), observation]); }
    finally { cancelled = true; await observation; }
  }

  it.each(['read', 'write', 'object-read', 'object-write'] as const)('authorizes paid Chat while a same-owner authenticated R2 %s is still pending', async kind => {
    const read = startStorage(kind); await entered.promise;
    const authorization = authorize();
    const outcome = await observeCompetition(authorization, fundingName, 'authorized_while_read_pending');
    // Always release the fake external read before asserting, including the RED case.
    release.resolve(); expect((await read).status).toBe(200);
    expect((await authorization).reservation).toMatchObject({ modelId, billingPolicy: 'postpaid', reservedMicrousd: 0 });
    expect(outcome).toBe('authorized_while_read_pending');
  });

  it.each(['read', 'write', 'object-read', 'object-write'] as const)('keeps deletion acceptance behind the complete admitted R2 %s', async kind => {
    const read = startStorage(kind); await entered.promise;
    const deletion = new AccountDeletionRepository(deletionDb.kysely, { secret, now: () => new Date(now) })
      .accept({ clerkUserId: identity.ownerId, appleTokens: [] }, false);
    pending.push(deletion);
    const outcome = await observeCompetition(deletion, deletionName, 'accepted_before_read_completed');
    release.resolve(); expect((await read).status).toBe(200); await deletion;
    expect(outcome).toBe('blocked_by_account_deletion_lock');
    await expect(authorize()).rejects.toMatchObject({ code: 'access_disabled' });
  });

  it.each(['read', 'write', 'object-read', 'object-write'] as const)('serializes storage write-vs-%s publication while financial authorization proceeds', async secondKind => {
    const first = startStorage('object-write'); await entered.promise;
    const second = startStorage(secondKind), authorization = authorize();
    const publication = await observeCompetition(second, `${schema}_storage`, 'published_before_first_completed', null);
    const financial = await observeCompetition(authorization, fundingName, 'authorized_before_write_completed');
    const callsBeforeFirstCompleted = storageCalls;
    release.resolve(); expect((await first).status).toBe(200); expect((await second).status).toBe(200); await authorization;
    expect(publication).toBe('blocked_by_owner_lock'); expect(callsBeforeFirstCompleted).toBe(1);
    expect(financial).toBe('authorized_before_write_completed');
  });

  it('retains the exclusive billing owner lock for funded authorization', async () => {
    const financial = deletionDb.transaction(async trx => { await lockBillingOwner(trx, identity.ownerId); entered.resolve(); await release.promise; });
    pending.push(financial); await entered.promise;
    const authorization = authorize();
    const outcome = await observeCompetition(authorization, fundingName, 'authorized_without_billing_lock', `billing-owner:${identity.ownerId}`);
    release.resolve(); await financial; await authorization;
    expect(outcome).toBe('blocked_by_owner_lock');
  });

  it('keeps the existing generic owner helper exclusive', async () => {
    const mutation = withAccountDeletionOwnerLock(deletionDb, identity.ownerId, async () => { entered.resolve(); await release.promise; });
    pending.push(mutation); await entered.promise;
    const authorization = authorize();
    const outcome = await observeCompetition(authorization, fundingName, 'authorized_during_exclusive_mutation');
    release.resolve(); await mutation; await authorization;
    expect(outcome).toBe('blocked_by_account_deletion_lock');
  });

  it('retains legacy billing serialization when the deletion secret is absent', async () => {
    vi.stubEnv('ACCOUNT_DELETION_SECRET', undefined);
    const write = startStorage('write'); await entered.promise;
    const authorization = authorize();
    const outcome = await observeCompetition(authorization, fundingName, 'authorized_without_legacy_fence', `billing-owner:${identity.ownerId}`);
    release.resolve(); expect((await write).status).toBe(200); await authorization;
    expect(outcome).toBe('blocked_by_owner_lock');
  });

  it.each(['cancel', 'accelerate'] as const)('keeps deletion %s behind an in-progress grace read', async operation => {
    const repository = new AccountDeletionRepository(deletionDb.kysely, { secret });
    await repository.accept({ clerkUserId: identity.ownerId, appleTokens: [] }, false);
    await deletionDb.executor.updateTable('account_deletion_jobs').set({ billing_stopped: true }).execute();
    const read = startStorage('read'); await entered.promise;
    const transition = repository[operation](identity.ownerId); pending.push(transition);
    const outcome = await observeCompetition(transition, deletionName, 'transitioned_before_read_completed');
    release.resolve(); expect((await read).status).toBe(200); await transition;
    expect(outcome).toBe('blocked_by_account_deletion_lock');
    if (operation === 'cancel') await expect(authorize()).resolves.toHaveProperty('reservation');
    else { expect((await startStorage('read')).status).toBe(409); await expect(authorize()).rejects.toMatchObject({ code: 'access_disabled' }); }
  });

  it.each(['error', 'abort'] as const)('releases the storage lane after an external %s', async kind => {
    storageFailure = kind;
    const read = startStorage('read'); await entered.promise; release.resolve();
    expect((await read).status).toBe(502);
    await expect(authorize()).resolves.toHaveProperty('reservation');
    storageFailure = undefined; expect((await startStorage('write')).status).toBe(200);
  });
});
