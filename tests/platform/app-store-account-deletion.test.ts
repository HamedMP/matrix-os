import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { ensurePlatformUser, type PlatformDB } from '../../packages/platform/src/db.js';
import { createAppStoreRepository } from '../../packages/platform/src/app-store/repository.js';
import { eraseOwnerPlatformData } from '../../packages/platform/src/account-deletion/cleanup-data.js';
import { ownerStoragePrefixes } from '../../packages/platform/src/account-deletion/storage.js';
import { exportOwnerPlatformData } from '../../packages/platform/src/account-deletion/export.js';
import { AppStoreCreateSubmissionSchema } from '../../packages/contracts/src/app-store.js';
let db: PlatformDB;
afterEach(async () => { await destroyTestPlatformDb(db); });
describe('App Store account ownership erasure', () => {
  it('delists published apps, erases private submissions and owner edges while preserving other users data', async () => {
    ({ db } = await createTestPlatformDb());
    const owner = { userId: 'user_owner', handle: 'owner' }; const other = { userId: 'user_other', handle: 'other' };
    await ensurePlatformUser(db, { clerkId: owner.userId, handle: owner.handle, displayName: 'Owner', email: 'owner@example.test', containerId: 'clerk:user_owner' });
    const pair = generateKeyPairSync('ed25519'); const repository = createAppStoreRepository(db, { signing: { keyId: 'v1', privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() } });
    const input = (slug: string, version = '1.0.0') => AppStoreCreateSubmissionSchema.parse({ submissionKey: `${slug}:draft:${version}`, listing: { slug, name: 'Garden', tagline: 'Sample', description: 'Sample', category: 'utilities' }, version, changelog: '', license: 'MIT', manifest: { name: 'Garden', description: 'Sample', runtime: 'vite', version }, source: { sha256: 'a'.repeat(64), size: 3 }, generalizationReport: { ai: 'completed', changes: [] } });
    const published = await repository.createSubmission(owner, input('garden')); await repository.beginScan(owner.userId, published.id); await repository.completeScan(published.id, { blocking: false, truncated: false, findings: [] }, 'verified/source'); await repository.decide('reviewer', published.id, { type: 'approve' });
    const pending = await repository.createSubmission(owner, input('garden', '1.1.0'));
    const foreign = await repository.createSubmission(other, input('another')); await repository.beginScan(other.userId, foreign.id); await repository.completeScan(foreign.id, { blocking: false, truncated: false, findings: [] }, 'verified/foreign'); await repository.decide('reviewer', foreign.id, { type: 'approve' });
    await repository.install(owner.userId, 'another', foreign.id); await repository.rate(owner.userId, 'another', 5);
    await repository.install('user_consumer', 'garden', published.id);
    expect((await exportOwnerPlatformData(db, owner.userId))).toHaveProperty('appStore');
    await eraseOwnerPlatformData(db, owner.userId);
    expect((await repository.catalog({ sort: 'popular', limit: 50 })).listings.map(listing => listing.slug)).toEqual(['another']);
    await expect(repository.getVersion(pending.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await repository.getVersion(published.id)).submitted_by_clerk_user_id).not.toBe(owner.userId);
    expect((await db.executor.selectFrom('app_store_installs').selectAll().where('clerk_user_id', '=', 'user_consumer').execute())).toHaveLength(1);
    expect(await repository.detail('another', other.userId)).toMatchObject({ installCount: 0, activeInstallCount: 0, ratingCount: 0, ratingAverage: null });
    await expect(repository.install('user_new', 'garden', published.id)).rejects.toMatchObject({ code: 'forbidden' });
    await eraseOwnerPlatformData(db, owner.userId);
  });
  it('includes app-store source and upload copies under the canonical owner storage deletion boundary', () => {
    expect(ownerStoragePrefixes('user_owner', 'matrixos-sync')).toContain('app-store/owners/user_owner/');
  });
});
