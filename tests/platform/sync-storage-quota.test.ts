import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createInternalSyncRoutes } from '../../packages/platform/src/internal-sync-routes.js';
import { createStorageQuota, DEFAULT_STORAGE_QUOTA_LIMITS } from '../../packages/platform/src/free-tier/storage-quota.js';
import { loadContainerStorageLimits } from '../../packages/platform/src/free-tier/config.js';
import { buildPlatformSyncVerificationToken, buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createScopedPlatformDbs, freeTierPostgresUrl, type ScopedPlatformDbs } from './free-tier-postgres-helper.js';

const SECRET = 'platform-secret-quota-0123456789abcdef';
const FREE_OWNER = 'user_quotafree';
const VPS_OWNER = 'user_quotavps';
const FREE_PREFIX = `matrixos-sync/${FREE_OWNER}`;
const VPS_PREFIX = `matrixos-sync/${VPS_OWNER}`;
const hex = (n: number) => n.toString(16).padStart(64, '0');

function fakeR2() {
  const sizes = new Map<string, number>();
  return {
    sizes,
    getPresignedGetUrl: vi.fn(async (key: string) => `https://r2.test/get/${key}`),
    getPresignedPutUrl: vi.fn(async (key: string) => `https://r2.test/put/${key}`),
    headObject: vi.fn(async (key: string) => sizes.has(key)
      ? { exists: true, contentLength: sizes.get(key) } : { exists: false }),
    listMultipartUploads: vi.fn(async () => []),
    createMultipartUpload: vi.fn(async () => 'upload-1'),
    getPresignedPartUrl: vi.fn(async () => 'https://r2.test/part'),
    completeMultipartUpload: vi.fn(async () => ({ etag: 'etag-mp' })),
    abortMultipartUpload: vi.fn(async () => {}),
    getObject: vi.fn(async () => ({ body: null })),
    putObject: vi.fn(async (key: string, body: unknown, options?: { contentLength?: number }) => {
      sizes.set(key, options?.contentLength ?? (body instanceof Uint8Array ? body.byteLength : 0));
      return { etag: 'etag-put' };
    }),
    deleteObject: vi.fn(async (key: string) => { sizes.delete(key); }),
  };
}

async function seedMachines(db: PlatformDB) {
  await insertUserMachine(db, {
    machineId: 'ctr-quota', clerkUserId: FREE_OWNER, handle: 'quotafree', status: 'running',
    imageVersion: null, provisionedAt: '2026-11-12T00:00:00.000Z', substrate: 'container', activationState: 'authorized',
  });
  await insertUserMachine(db, {
    machineId: 'vps-quota', clerkUserId: VPS_OWNER, handle: 'quotavps', status: 'running',
    imageVersion: 'b1', provisionedAt: '2026-11-12T00:00:00.000Z',
  });
}

function headersFor(handle: string, machineId: string) {
  return {
    authorization: `Bearer ${buildPlatformSyncVerificationToken({ handle, machineId, runtimeSlot: 'primary' }, SECRET)}`,
    'x-matrix-machine-id': machineId,
    'x-matrix-runtime-slot': 'primary',
    'content-type': 'application/json',
  };
}

describe('sync broker storage quota for container runtimes', () => {
  let db: PlatformDB;
  let r2: ReturnType<typeof fakeR2>;
  let clock: number;
  const free = headersFor('quotafree', 'ctr-quota');
  const vps = headersFor('quotavps', 'vps-quota');

  function app(limits = { maxBytes: 1000, maxFiles: 3 }) {
    return new Hono().route('/sync/:handle', createInternalSyncRoutes({
      db, r2, platformSecret: SECRET, r2PrefixRoot: 'matrixos-sync', storageLimits: limits, now: () => new Date(clock),
    }));
  }
  const presignPut = (target: Hono, headers: Record<string, string>, key: string, size: number) =>
    target.request(`/sync/${headers === vps ? 'quotavps' : 'quotafree'}/presign/put`, {
      method: 'POST', headers, body: JSON.stringify({ key, size }),
    });
  const usage = async (owner = FREE_OWNER) => db.executor.selectFrom('runtime_storage_usage')
    .select(['object_bytes', 'object_count']).where('clerk_user_id', '=', owner).executeTakeFirst();

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await seedMachines(db);
    r2 = fakeR2();
    clock = Date.parse('2026-11-12T10:00:00.000Z');
  });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  it('refuses a write that would pass the byte quota with a generic code and never signs it', async () => {
    const target = app();
    expect((await presignPut(target, free, `${FREE_PREFIX}/objects/sha256/${hex(1)}`, 600)).status).toBe(200);
    const refused = await presignPut(target, free, `${FREE_PREFIX}/objects/sha256/${hex(2)}`, 401);
    expect(refused.status).toBe(507);
    expect(await refused.json()).toEqual({ error: 'Storage limit reached', code: 'storage_full' });
    expect(r2.getPresignedPutUrl).toHaveBeenCalledTimes(1);
    expect(await usage()).toEqual({ object_bytes: 600, object_count: 1 });
  });

  it('refuses the handle-only token for a container runtime, so a replaced unit cannot reach storage', async () => {
    const target = app();
    const handleOnly = (handle: string) => ({
      authorization: `Bearer ${buildPlatformVerificationToken(handle, SECRET)}`, 'content-type': 'application/json',
    });
    const refused = await target.request('/sync/quotafree/presign/put', {
      method: 'POST', headers: handleOnly('quotafree'), body: JSON.stringify({ key: `${FREE_PREFIX}/manifest.json`, size: 10 }),
    });
    expect(refused.status).toBe(401);
    expect(r2.getPresignedPutUrl).not.toHaveBeenCalled();
    const vpsAllowed = await target.request('/sync/quotavps/presign/put', {
      method: 'POST', headers: handleOnly('quotavps'), body: JSON.stringify({ key: `${VPS_PREFIX}/manifest.json`, size: 10 }),
    });
    expect(vpsAllowed.status).toBe(200);
  });

  it('leaves VPS owners unmetered', async () => {
    const response = await presignPut(app(), vps, `${VPS_PREFIX}/objects/sha256/${hex(1)}`, 5000);
    expect(response.status).toBe(200);
    expect(await usage(VPS_OWNER)).toBeUndefined();
  });

  it('counts an overwrite of the same key once', async () => {
    const target = app();
    const key = `${FREE_PREFIX}/manifest.json`;
    expect((await presignPut(target, free, key, 700)).status).toBe(200);
    expect((await presignPut(target, free, key, 900)).status).toBe(200);
    expect((await presignPut(target, free, key, 300)).status).toBe(200);
    // All three URLs can still write the key, so it holds the largest until they expire.
    expect(await usage()).toEqual({ object_bytes: 900, object_count: 0 });
    r2.sizes.set(key, 300);
    clock += 17 * 60_000;
    expect((await presignPut(target, free, `${FREE_PREFIX}/staging/${randomUUID()}`, 700)).status).toBe(200);
    expect(await usage()).toEqual({ object_bytes: 1000, object_count: 0 });
  });

  it('keeps read and delete working at the limit, and a delete frees the space once its signed URL expires', async () => {
    const target = app();
    const key = `${FREE_PREFIX}/objects/sha256/${hex(3)}`;
    expect((await presignPut(target, free, key, 1000)).status).toBe(200);
    expect((await presignPut(target, free, `${FREE_PREFIX}/staging/${randomUUID()}`, 1)).status).toBe(507);
    const read = await target.request('/sync/quotafree/presign/get', { method: 'POST', headers: free, body: JSON.stringify({ key }) });
    expect(read.status).toBe(200);
    const removed = await target.request(`/sync/quotafree/object?key=${encodeURIComponent(key)}`, { method: 'DELETE', headers: free });
    expect(removed.status).toBe(200);
    // The signed URL could still recreate the key, so its hold stays until the URL expires.
    expect(await usage()).toEqual({ object_bytes: 1000, object_count: 1 });
    clock += 17 * 60_000;
    expect((await presignPut(target, free, `${FREE_PREFIX}/objects/sha256/${hex(4)}`, 1000)).status).toBe(200);
    expect(await usage()).toEqual({ object_bytes: 1000, object_count: 1 });
  });

  it('frees a deleted key at once when no signed upload for it is outstanding', async () => {
    const target = app();
    const key = `${FREE_PREFIX}/staging/${randomUUID()}`;
    const put = await target.request(`/sync/quotafree/object?key=${encodeURIComponent(key)}`, {
      method: 'PUT', headers: { ...free, 'content-type': 'application/octet-stream' }, body: new Uint8Array(400),
    });
    expect(put.status).toBe(200);
    await target.request(`/sync/quotafree/object?key=${encodeURIComponent(key)}`, { method: 'DELETE', headers: free });
    expect(await usage()).toEqual({ object_bytes: 0, object_count: 0 });
  });

  it('keeps the larger signed hold when the same key is overwritten small before that URL expires', async () => {
    const target = app();
    const key = `${FREE_PREFIX}/staging/${randomUUID()}`;
    expect((await presignPut(target, free, key, 800)).status).toBe(200);
    const small = await target.request(`/sync/quotafree/object?key=${encodeURIComponent(key)}`, {
      method: 'PUT', headers: { ...free, 'content-type': 'application/octet-stream' }, body: new Uint8Array(100),
    });
    expect(small.status).toBe(200);
    expect(await usage()).toEqual({ object_bytes: 800, object_count: 0 });
    // The older signed URL is used last and the larger object lands.
    r2.sizes.set(key, 800);
    expect((await presignPut(target, free, `${FREE_PREFIX}/staging/${randomUUID()}`, 300)).status).toBe(507);
    clock += 17 * 60_000;
    expect((await presignPut(target, free, `${FREE_PREFIX}/staging/${randomUUID()}`, 300)).status).toBe(507);
    expect(await db.executor.selectFrom('runtime_storage_objects').select(['bytes', 'pending_until'])
      .where('object_key', '=', key).executeTakeFirstOrThrow()).toEqual({ bytes: 800, pending_until: null });
  });

  it('removes an oversized multipart overwrite of a counted key and stops counting it', async () => {
    const target = app();
    const key = `${FREE_PREFIX}/objects/sha256/${hex(10)}`;
    const put = await target.request(`/sync/quotafree/object?key=${encodeURIComponent(key)}`, {
      method: 'PUT', headers: { ...free, 'content-type': 'application/octet-stream' }, body: new Uint8Array(100),
    });
    expect(put.status).toBe(200);
    r2.completeMultipartUpload.mockImplementation(async (k: string) => { r2.sizes.set(k, 5000); return { etag: 'mp' }; });
    const refused = await target.request('/sync/quotafree/multipart/complete', {
      method: 'POST', headers: free,
      body: JSON.stringify({ key, uploadId: 'upload-1', parts: [{ partNumber: 1, etag: 'p1' }] }),
    });
    expect(refused.status).toBe(507);
    expect(r2.deleteObject).toHaveBeenCalledWith(key);
    expect(r2.sizes.has(key)).toBe(false);
    expect(await usage()).toEqual({ object_bytes: 0, object_count: 0 });
  });

  it('enforces the file-count limit on file blobs while manifests still fit', async () => {
    const target = app({ maxBytes: 10_000, maxFiles: 2 });
    expect((await presignPut(target, free, `${FREE_PREFIX}/objects/sha256/${hex(5)}`, 10)).status).toBe(200);
    expect((await presignPut(target, free, `${FREE_PREFIX}/objects/sha256/${hex(6)}`, 10)).status).toBe(200);
    const refused = await presignPut(target, free, `${FREE_PREFIX}/objects/sha256/${hex(7)}`, 10);
    expect(refused.status).toBe(507);
    expect(await refused.json()).toEqual({ error: 'File limit reached', code: 'file_limit_reached' });
    expect((await presignPut(target, free, `${FREE_PREFIX}/manifests/2-${hex(8)}.json`, 10)).status).toBe(200);
    expect(await usage()).toEqual({ object_bytes: 30, object_count: 2 });
  });

  it('meters a proxied upload by its declared length and confirms it', async () => {
    const target = app();
    const key = `${FREE_PREFIX}/staging/${randomUUID()}`;
    const ok = await target.request(`/sync/quotafree/object?key=${encodeURIComponent(key)}`, {
      method: 'PUT', headers: { ...free, 'content-type': 'application/octet-stream' }, body: new Uint8Array(400),
    });
    expect(ok.status).toBe(200);
    const pending = await db.executor.selectFrom('runtime_storage_objects').select(['bytes', 'pending_until'])
      .where('object_key', '=', key).executeTakeFirstOrThrow();
    expect(pending).toEqual({ bytes: 400, pending_until: null });
    const refused = await target.request(`/sync/quotafree/object?key=${encodeURIComponent(`${FREE_PREFIX}/staging/${randomUUID()}`)}`, {
      method: 'PUT', headers: { ...free, 'content-type': 'application/octet-stream' }, body: new Uint8Array(601),
    });
    expect(refused.status).toBe(507);
    expect(r2.putObject).toHaveBeenCalledTimes(1);
  });

  it('meters a multipart upload at completion and removes a new object that does not fit', async () => {
    const target = app();
    const key = `${FREE_PREFIX}/objects/sha256/${hex(9)}`;
    r2.completeMultipartUpload.mockImplementation(async (k: string) => { r2.sizes.set(k, 1200); return { etag: 'mp' }; });
    const refused = await target.request('/sync/quotafree/multipart/complete', {
      method: 'POST', headers: free,
      body: JSON.stringify({ key, uploadId: 'upload-1', parts: [{ partNumber: 1, etag: 'p1' }] }),
    });
    expect(refused.status).toBe(507);
    expect(r2.deleteObject).toHaveBeenCalledWith(key);
    expect(await usage()).toEqual({ object_bytes: 0, object_count: 0 });
  });

  it('still counts a multipart upload whose size check failed after completion', async () => {
    const target = app();
    const key = `${FREE_PREFIX}/objects/sha256/${hex(11)}`;
    r2.completeMultipartUpload.mockImplementation(async (k: string) => { r2.sizes.set(k, 900); return { etag: 'mp' }; });
    r2.headObject.mockRejectedValueOnce(new Error('store timeout'));
    const failed = await target.request('/sync/quotafree/multipart/complete', {
      method: 'POST', headers: free,
      body: JSON.stringify({ key, uploadId: 'upload-1', parts: [{ partNumber: 1, etag: 'p1' }] }),
    });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    clock += 3 * 60_000;
    // A refused write runs reconciliation, which must find and count the stored object.
    expect((await presignPut(target, free, `${FREE_PREFIX}/staging/${randomUUID()}`, 1001)).status).toBe(507);
    expect(await usage()).toMatchObject({ object_bytes: 900 });
    expect((await presignPut(target, free, `${FREE_PREFIX}/staging/${randomUUID()}`, 101)).status).toBe(507);
  });

  it('counts a recovered multipart file blob against the file limit', async () => {
    const target = app({ maxBytes: 10_000, maxFiles: 1 });
    const key = `${FREE_PREFIX}/objects/sha256/${hex(12)}`;
    r2.completeMultipartUpload.mockImplementation(async (k: string) => { r2.sizes.set(k, 900); return { etag: 'mp' }; });
    r2.headObject.mockRejectedValueOnce(new Error('store timeout'));
    const failed = await target.request('/sync/quotafree/multipart/complete', {
      method: 'POST', headers: free,
      body: JSON.stringify({ key, uploadId: 'upload-1', parts: [{ partNumber: 1, etag: 'p1' }] }),
    });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    clock += 3 * 60_000;
    expect((await presignPut(target, free, `${FREE_PREFIX}/staging/${randomUUID()}`, 10_001)).status).toBe(507);
    expect(await usage()).toEqual({ object_bytes: 900, object_count: 1 });
    // The recovered blob holds the only file slot.
    expect((await presignPut(target, free, `${FREE_PREFIX}/objects/sha256/${hex(13)}`, 1)).status).toBe(507);
  });

  it('refuses a multipart completion of a new file blob past the file limit before it lands', async () => {
    const target = app({ maxBytes: 10_000, maxFiles: 1 });
    expect((await presignPut(target, free, `${FREE_PREFIX}/objects/sha256/${hex(14)}`, 10)).status).toBe(200);
    const refused = await target.request('/sync/quotafree/multipart/complete', {
      method: 'POST', headers: free,
      body: JSON.stringify({ key: `${FREE_PREFIX}/objects/sha256/${hex(15)}`, uploadId: 'upload-1', parts: [{ partNumber: 1, etag: 'p1' }] }),
    });
    expect(refused.status).toBe(507);
    expect(r2.completeMultipartUpload).not.toHaveBeenCalled();
  });

  it('reclaims a signed upload that never arrived once its URL has expired', async () => {
    const target = app();
    expect((await presignPut(target, free, `${FREE_PREFIX}/staging/${randomUUID()}`, 900)).status).toBe(200);
    expect((await presignPut(target, free, `${FREE_PREFIX}/staging/${randomUUID()}`, 500)).status).toBe(507);
    clock += 20 * 60_000;
    expect((await presignPut(target, free, `${FREE_PREFIX}/staging/${randomUUID()}`, 500)).status).toBe(200);
    expect(await usage()).toEqual({ object_bytes: 500, object_count: 0 });
  });

  it('settles a reclaimed reservation at the size that actually landed', async () => {
    const target = app();
    const key = `${FREE_PREFIX}/staging/${randomUUID()}`;
    expect((await presignPut(target, free, key, 900)).status).toBe(200);
    r2.sizes.set(key, 900);
    clock += 20 * 60_000;
    expect((await presignPut(target, free, `${FREE_PREFIX}/staging/${randomUUID()}`, 200)).status).toBe(507);
    expect(await db.executor.selectFrom('runtime_storage_objects').select('pending_until')
      .where('object_key', '=', key).executeTakeFirstOrThrow()).toEqual({ pending_until: null });
  });
});

describe('container storage limit settings', () => {
  it('defaults to 2 GiB and 50,000 files', () => {
    expect(loadContainerStorageLimits({})).toEqual({ maxBytes: 2 * 1024 ** 3, maxFiles: 50_000 });
  });

  it('accepts overrides and keeps the defaults when one is invalid, naming only the setting', () => {
    expect(loadContainerStorageLimits({ MATRIX_CONTAINER_HOME_MAX_BYTES: '1000', MATRIX_CONTAINER_HOME_MAX_FILES: '9' }))
      .toEqual({ maxBytes: 1000, maxFiles: 9 });
    const log = vi.fn();
    expect(loadContainerStorageLimits({ MATRIX_CONTAINER_HOME_MAX_FILES: '-1' }, log)).toEqual(DEFAULT_STORAGE_QUOTA_LIMITS);
    expect(log).toHaveBeenCalledWith('[platform] container storage limits use defaults; invalid settings: MATRIX_CONTAINER_HOME_MAX_FILES');
  });
});

describe.skipIf(!freeTierPostgresUrl)('sync storage quota races against real Postgres', () => {
  let scoped: ScopedPlatformDbs;
  beforeAll(async () => { scoped = await createScopedPlatformDbs('sync_quota', 2); });
  afterAll(async () => { await scoped.close(); });

  const quotaFor = (db: PlatformDB, limits: { maxBytes: number; maxFiles: number }) =>
    createStorageQuota({ db, limits, headObject: async () => ({ exists: false }) });

  it('never overshoots the byte quota under concurrent writes from two pools', async () => {
    const owner = `user_race${randomUUID().slice(0, 8)}`;
    const quotas = scoped.pools.map(db => quotaFor(db, { maxBytes: 1000, maxFiles: 1000 }));
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => quotas[index % 2]!.authorize(owner, {
      key: `matrixos-sync/${owner}/objects/sha256/${hex(index)}`, bytes: 100, countsAsFile: true, pendingMs: null,
    })));
    expect(results.filter(result => result.ok)).toHaveLength(10);
    const row = await scoped.pools[0]!.executor.selectFrom('runtime_storage_usage').select(['object_bytes', 'object_count'])
      .where('clerk_user_id', '=', owner).executeTakeFirstOrThrow();
    expect({ bytes: Number(row.object_bytes), count: row.object_count }).toEqual({ bytes: 1000, count: 10 });
  });

  it('counts concurrent writes of one key once', async () => {
    const owner = `user_race${randomUUID().slice(0, 8)}`;
    const quotas = scoped.pools.map(db => quotaFor(db, { maxBytes: 1000, maxFiles: 1000 }));
    const key = `matrixos-sync/${owner}/objects/sha256/${hex(42)}`;
    await scoped.pools[0]!.executor.insertInto('runtime_storage_usage').values({ clerk_user_id: owner }).execute();
    // Hold the owner's row so every write queues behind it and reads the ledger only after the holder commits.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let held!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const holder = scoped.pools[0]!.transaction(async (trx) => {
      await trx.executor.selectFrom('runtime_storage_usage').select('clerk_user_id')
        .where('clerk_user_id', '=', owner).forUpdate().execute();
      held();
      await gate;
    });
    await holding;
    const pending = Array.from({ length: 20 }, (_, index) =>
      quotas[index % 2]!.authorize(owner, { key, bytes: 100, countsAsFile: true, pendingMs: null }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await holder;
    const results = await Promise.all(pending);
    expect(results.every(result => result.ok)).toBe(true);
    const row = await scoped.pools[1]!.executor.selectFrom('runtime_storage_usage').select(['object_bytes', 'object_count'])
      .where('clerk_user_id', '=', owner).executeTakeFirstOrThrow();
    expect({ bytes: Number(row.object_bytes), count: row.object_count }).toEqual({ bytes: 100, count: 1 });
  });

  it('never overshoots the file-count limit while writes and deletes interleave', async () => {
    const owner = `user_race${randomUUID().slice(0, 8)}`;
    const quotas = scoped.pools.map(db => quotaFor(db, { maxBytes: 1_000_000, maxFiles: 5 }));
    const keys = Array.from({ length: 20 }, (_, index) => `matrixos-sync/${owner}/objects/sha256/${hex(index + 100)}`);
    await Promise.all(keys.map((key, index) => quotas[index % 2]!.authorize(owner, { key, bytes: 1, countsAsFile: true, pendingMs: null })
      .then(result => (result.ok && index % 3 === 0 ? quotas[(index + 1) % 2]!.release(owner, key) : undefined))));
    const ledger = await scoped.pools[0]!.executor.selectFrom('runtime_storage_objects').select(['bytes'])
      .where('clerk_user_id', '=', owner).execute();
    const row = await scoped.pools[0]!.executor.selectFrom('runtime_storage_usage').select(['object_bytes', 'object_count'])
      .where('clerk_user_id', '=', owner).executeTakeFirstOrThrow();
    expect(row.object_count).toBeLessThanOrEqual(5);
    expect(row.object_count).toBe(ledger.length);
    expect(Number(row.object_bytes)).toBe(ledger.length);
  });
});
