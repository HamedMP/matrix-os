import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountDeletionRepository } from '../../packages/platform/src/account-deletion/repository.js';
import { createInternalSyncRoutes } from '../../packages/platform/src/internal-sync-routes.js';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { insertContainer, type PlatformDB } from '../../packages/platform/src/db.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const secret = 'storage-admission-secret-at-least-32-bytes';
const owner = 'user_storage_deletion';
const handle = 'storage-deletion';
const platformSecret = 'platform-secret';
const key = `matrixos-sync/${owner}/files/test.txt`;

describe('account deletion storage admission', () => {
  let db: PlatformDB;
  let app: Hono;
  const r2 = {
    getPresignedGetUrl: vi.fn(async () => 'https://storage.example/get'),
    getPresignedPutUrl: vi.fn(async () => 'https://storage.example/put'),
    headObject: vi.fn(async () => ({ exists: true })),
    createMultipartUpload: vi.fn(async () => 'upload'),
    getPresignedPartUrl: vi.fn(async () => 'https://storage.example/part'),
    getObject: vi.fn(async () => ({ body: new Uint8Array([1]) })), putObject: vi.fn(async () => ({ etag: 'etag' })),
    deleteObject: vi.fn(async () => {}), completeMultipartUpload: vi.fn(async () => {}),
    abortMultipartUpload: vi.fn(async () => {}), listMultipartUploads: vi.fn(async () => []),
  };
  const headers = { authorization: `Bearer ${buildPlatformVerificationToken(handle, platformSecret)}`, 'content-type': 'application/json' };
  beforeEach(async () => {
    vi.clearAllMocks(); vi.stubEnv('ACCOUNT_DELETION_SECRET', secret);
    ({ db } = await createTestPlatformDb());
    await insertContainer(db, { handle, clerkUserId: owner, status: 'running', port: 4000, shellPort: 3000 });
    app = new Hono().route('/internal/containers/:handle/sync', createInternalSyncRoutes({ db, r2, platformSecret, r2PrefixRoot: 'matrixos-sync' }));
    await new AccountDeletionRepository(db.kysely, { secret }).accept({ clerkUserId: owner, appleTokens: [] }, false);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await destroyTestPlatformDb(db); });
  it('refuses new write signatures and multipart uploads while export GET signatures remain available', async () => {
    for (const path of ['/presign/put', '/multipart/create', '/multipart/part']) {
      const response = await app.request(`/internal/containers/${handle}/sync${path}`, { method: 'POST', headers, body: JSON.stringify({ key, size: 1, uploadId: 'upload', partNumber: 1 }) });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'Account deletion is pending' });
    }
    expect(r2.getPresignedPutUrl).not.toHaveBeenCalled(); expect(r2.createMultipartUpload).not.toHaveBeenCalled();
    const read = await app.request(`/internal/containers/${handle}/sync/presign/get`, { method: 'POST', headers, body: JSON.stringify({ key }) });
    expect(read.status).toBe(200);
  });
  it('refuses reads and writes after destruction begins', async () => {
    await db.executor.updateTable('account_deletion_jobs').set({ status: 'processing' }).execute();
    const response = await app.request(`/internal/containers/${handle}/sync/presign/get`, { method: 'POST', headers, body: JSON.stringify({ key }) });
    expect(response.status).toBe(409); expect(r2.getPresignedGetUrl).not.toHaveBeenCalled();
  });
});
