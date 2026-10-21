import { describe, expect, it, vi } from 'vitest';
import { buildSyncStoragePrefix } from '../../packages/contracts/src/sync.js';
import { listAccountExportFiles } from '../../packages/platform/src/account-deletion/export.js';
import {
  eraseOwnerStorage, ownerStoragePrefixes, type AccountDeletionObjectStore,
} from '../../packages/platform/src/account-deletion/storage.js';

const owner = 'user_a';
const primary = `${buildSyncStoragePrefix({ ownerId: owner, runtimeSlot: 'primary' })}/`;
const studio = `${buildSyncStoragePrefix({ ownerId: owner, runtimeSlot: 'studio' })}/`;
const secondaryOwner = 'matrixos-sync/v2/owners/user_a/runtimes/';

function memoryStore(initial: string[]) {
  const keys = new Set(initial);
  const aborted: string[] = [];
  const listed: Array<{ prefix: string; cursor?: string }> = [];
  const store: AccountDeletionObjectStore = {
    async listObjects(prefix, cursor) {
      listed.push({ prefix, cursor });
      const matching = [...keys].filter((key) => key.startsWith(prefix));
      const offset = cursor ? Number(cursor) : 0;
      return { keys: matching.slice(offset, offset + 1), nextCursor: offset + 1 < matching.length ? String(offset + 1) : null };
    },
    deleteObject: vi.fn(async (key: string) => { keys.delete(key); }),
    async abortOwnerMultipartUploads(prefix) { aborted.push(prefix); },
    getPresignedGetUrl: vi.fn(async (key: string) => `https://download.example/${key}`),
  };
  return { store, keys, aborted, listed };
}

describe('account deletion secondary runtime storage', () => {
  it('covers legacy, configured and canonical secondary runtime namespaces with exact owner boundaries', () => {
    expect(ownerStoragePrefixes(owner, 'custom/sync')).toEqual([
      primary, 'custom/sync/user_a/', secondaryOwner,
    ]);
    expect(ownerStoragePrefixes(owner, 'matrixos-sync')).toEqual([primary, secondaryOwner]);
  });

  it('aborts multipart uploads and erases every runtime in bounded restartable pages', async () => {
    const keep = [
      'matrixos-sync/user_ab/files/neighbor.md',
      'matrixos-sync/v2/owners/user_ab/runtimes/studio/files/neighbor.md',
      'system-bundles/release/matrix-host-bundle.tar.gz',
    ];
    const erased = [
      `${primary}files/notes.md`, `${studio}files/studio.md`, `${studio}postgresql/app.dump`,
      `${buildSyncStoragePrefix({ ownerId: owner, runtimeSlot: 'staging' })}/manifest.json`,
      'custom/sync/user_a/files/legacy.md',
    ];
    const fixture = memoryStore([...keep, ...erased]);

    await eraseOwnerStorage(fixture.store, owner, 'custom/sync');

    expect([...fixture.keys]).toEqual(keep);
    expect(fixture.aborted).toEqual([primary, 'custom/sync/user_a/', secondaryOwner]);
    expect(fixture.store.deleteObject).toHaveBeenCalledTimes(erased.length);
    expect(fixture.listed.every((entry) => entry.cursor === undefined)).toBe(true);
    await eraseOwnerStorage(fixture.store, owner, 'custom/sync');
    expect(fixture.store.deleteObject).toHaveBeenCalledTimes(erased.length);
  });

  it('exports all continuation pages including the third owner prefix', async () => {
    const portable = [
      `${primary}files/notes.md`, 'custom/sync/user_a/files/legacy.md',
      `${studio}files/studio.md`, `${studio}postgresql/app.dump`,
    ];
    const fixture = memoryStore([...portable,
      'matrixos-sync/v2/owners/user_ab/runtimes/studio/files/private.md',
      'system-bundles/release/matrix-host-bundle.tar.gz',
    ]);
    const files = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await listAccountExportFiles(fixture.store, owner, 'custom/sync', cursor);
      files.push(...result.files);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
      if (page === 9) throw new Error('Export pagination did not terminate');
    }

    expect(files.map((file) => file.downloadUrl)).toEqual(portable.map((key) => `https://download.example/${key}`));
    expect(files.find((file) => file.path === 'studio/postgresql/app.dump')?.kind).toBe('database');
    expect(fixture.listed).toContainEqual({ prefix: secondaryOwner, cursor: '1' });
  });

  it.each([
    'matrixos-sync/v2/owners/user_ab/runtimes/studio/files/private.md',
    'system-bundles/release/matrix-host-bundle.tar.gz',
  ])('refuses unexpected objects returned under the secondary owner inventory: %s', async (foreignKey) => {
    const fixture = memoryStore([]);
    fixture.store.listObjects = vi.fn(async (prefix) => ({ keys: prefix === secondaryOwner ? [foreignKey] : [], nextCursor: null }));

    await expect(eraseOwnerStorage(fixture.store, owner, 'matrixos-sync')).rejects.toThrow('Storage ownership mismatch');
    expect(fixture.store.deleteObject).not.toHaveBeenCalled();
    const cursor = Buffer.from(JSON.stringify({ prefixIndex: 1 })).toString('base64url');
    await expect(listAccountExportFiles(fixture.store, owner, 'matrixos-sync', cursor)).rejects.toThrow('Storage ownership mismatch');
    expect(fixture.store.getPresignedGetUrl).not.toHaveBeenCalled();
  });
});
