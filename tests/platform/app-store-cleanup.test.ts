import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { createAppStoreRepository } from '../../packages/platform/src/app-store/repository.js';
import { createStoreSweeper } from '../../packages/platform/src/app-store/sweeper.js';
import { createStoreObjects } from '../../packages/platform/src/app-store/object-store.js';
import { AppStoreCreateSubmissionSchema } from '../../packages/contracts/src/app-store.js';
let db: PlatformDB;
afterEach(async () => { await destroyTestPlatformDb(db); });
describe('App Store durable cleanup', () => {
  it('removes expired uploads, retries deletion failure, and reclaims processed upload copies', async () => {
    ({ db } = await createTestPlatformDb());
    const now = Date.parse('2026-10-18T12:00:00Z'); const old = new Date(now - 2 * 86400000).toISOString();
    const repository = createAppStoreRepository(db, { now: () => old });
    const input = (version: string, submissionKey: string) => AppStoreCreateSubmissionSchema.parse({ submissionKey, listing: { slug: 'garden', name: 'Garden', tagline: 'Sample', description: 'Sample garden', category: 'utilities' }, version, changelog: '', license: 'MIT', manifest: { name: 'Garden', description: 'Sample', runtime: 'vite', version }, source: { sha256: 'a'.repeat(64), size: 10 }, generalizationReport: { ai: 'completed', changes: [] } });
    const first = await repository.createSubmission({ userId: 'user_owner', handle: 'owner' }, input('1.0.0', 'submission:first'));
    const second = await repository.createSubmission({ userId: 'user_owner', handle: 'owner' }, input('1.1.0', 'submission:second'));
    await repository.beginScan('user_owner', second.id); await repository.completeScan(second.id, { blocking: false, truncated: false, findings: [] }, `app-store/owners/user_owner/sources/${second.id}/${'a'.repeat(64)}`);
    const deletes: string[] = []; let fail = true;
    const objects = { delete: async (key: string) => { if (fail) throw new Error('storage unavailable'); deletes.push(key); } } as unknown as ReturnType<typeof createStoreObjects>;
    const sweeper = createStoreSweeper(db, objects, () => now);
    await expect(sweeper.sweep()).resolves.toBeUndefined(); expect(await repository.getVersion(first.id)).toBeTruthy();
    fail = false; await sweeper.sweep();
    await expect(repository.getVersion(first.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(deletes).toContain(`app-store/owners/user_owner/uploads/${second.id}`); expect((await repository.getVersion(second.id)).source_object_key).toContain('/sources/');
    const count = deletes.length; await sweeper.sweep(); expect(deletes.length).toBe(count);
    await sweeper.shutdown(); await sweeper.sweep(); expect(deletes.length).toBe(count);
  });
  it('keeps a failed candidate retryable while cleaning later expired and processed uploads', async () => {
    ({ db } = await createTestPlatformDb());
    const now = Date.parse('2026-10-18T12:00:00Z'); const old = new Date(now - 2 * 86400000).toISOString();
    const repository = createAppStoreRepository(db, { now: () => old });
    const create = (patch: number) => repository.createSubmission({ userId: 'user_owner', handle: 'owner' }, AppStoreCreateSubmissionSchema.parse({
      submissionKey: `cleanup:candidate:${patch}`, listing: { slug: 'garden', name: 'Garden', tagline: 'Sample', description: 'Sample', category: 'utilities' },
      version: `1.0.${patch}`, changelog: '', license: 'MIT', manifest: { name: 'Garden', description: 'Sample', runtime: 'vite', version: `1.0.${patch}` }, source: { sha256: 'a'.repeat(64), size: 10 }, generalizationReport: { ai: 'completed', changes: [] },
    }));
    const first = await create(0); const second = await create(1); const processed = await create(2); const processedSibling = await create(3);
    for (const version of [processed, processedSibling]) { await repository.beginScan('user_owner', version.id); await repository.completeScan(version.id, { blocking: false, truncated: false, findings: [] }, 'verified/source'); }
    let fail = true; const removed: string[] = [];
    const objects = { delete: async (key: string) => { if (fail && [first.source_object_key, `app-store/owners/user_owner/uploads/${processed.id}`].includes(key)) throw new Error('one object unavailable'); removed.push(key); } } as unknown as ReturnType<typeof createStoreObjects>;
    const sweeper = createStoreSweeper(db, objects, () => now);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await sweeper.sweep();
      expect(await repository.getVersion(first.id)).toBeTruthy();
      await expect(repository.getVersion(second.id)).rejects.toMatchObject({ code: 'not_found' });
      expect((await repository.getVersion(processed.id)).upload_cleaned_at).toBeNull();
      expect((await repository.getVersion(processedSibling.id)).upload_cleaned_at).not.toBeNull();
      expect(removed).toContain(`app-store/owners/user_owner/uploads/${processedSibling.id}`);
      expect(logged).toHaveBeenCalled();
      fail = false; await sweeper.sweep(); await expect(repository.getVersion(first.id)).rejects.toMatchObject({ code: 'not_found' });
      expect((await repository.getVersion(processed.id)).upload_cleaned_at).not.toBeNull();
    } finally { logged.mockRestore(); await sweeper.shutdown(); }
  });
  it('resets interrupted scans and clears its recurring timer on shutdown', async () => {
    ({ db } = await createTestPlatformDb()); const now = Date.now();
    const repository = createAppStoreRepository(db, { now: () => new Date(now - 700000).toISOString() });
    const input = AppStoreCreateSubmissionSchema.parse({ submissionKey: 'submission:scan', listing: { slug: 'garden', name: 'Garden', tagline: 'Sample', description: 'Sample', category: 'utilities' }, version: '1.0.0', changelog: '', license: 'MIT', manifest: { name: 'Garden', description: 'Sample', runtime: 'vite', version: '1.0.0' }, source: { sha256: 'b'.repeat(64), size: 1 }, generalizationReport: { ai: 'completed', changes: [] } });
    const version = await repository.createSubmission({ userId: 'owner', handle: 'owner' }, input); await repository.beginScan('owner', version.id);
    const sweeper = createStoreSweeper(db, { delete: vi.fn() } as unknown as ReturnType<typeof createStoreObjects>, () => now);
    await sweeper.sweep(); expect((await repository.getVersion(version.id)).status).toBe('awaiting_upload'); sweeper.start(); await sweeper.shutdown();
  });
});
