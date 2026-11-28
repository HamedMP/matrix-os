import { mkdtemp, writeFile, chmod, mkdir, symlink, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstat, unlink } from 'node:fs/promises';
const faults = vi.hoisted(() => ({ write: false, rename: false }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args); const write = handle.write.bind(handle);
    handle.write = ((...values: unknown[]) => faults.write ? Promise.reject(new Error('synthetic_disk_failure')) : Reflect.apply(write, handle, values)) as typeof handle.write;
    return handle;
  }, rename: async (...args: Parameters<typeof actual.rename>) => { if (faults.rename) throw new Error('synthetic_rename_failure'); return actual.rename(...args); } };
});
import { createGoogleOperatorEvidenceFiles } from '../../../packages/gateway/src/google-data/operator-evidence-files.js';
const roots: string[] = [];
async function folder() { const root = await mkdtemp(join(tmpdir(), 'google-review-')); roots.push(root); await chmod(root, 0o700); return realpath(root); }
afterEach(async () => { faults.write = false; faults.rename = false; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe('private operator evidence files', () => {
  it('reads only bounded owner-private regular files and creates a new exclusive receipt', async () => {
    const root = await folder(); await writeFile(join(root, 'terms.json'), 'evidence', { mode: 0o600 });
    const files = await createGoogleOperatorEvidenceFiles(root);
    try {
      expect((await files.readArtifact('terms.json')).toString()).toBe('evidence');
      await files.writeReceipt('receipt.json', { mode: 'dry-run' });
      await expect(files.writeReceipt('receipt.json', {})).rejects.toThrow('Google processing review unavailable');
      expect(JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8'))).toEqual({ mode: 'dry-run' });
    } finally { await files.close(); }
  });
  it('rejects traversal, symbolic links, public files, oversized files, and directories', async () => {
    const root = await folder(); await writeFile(join(root, 'private.json'), 'secret', { mode: 0o600 });
    await symlink(join(root, 'private.json'), join(root, 'link.json'));
    await writeFile(join(root, 'public.json'), 'public', { mode: 0o644 });
    await writeFile(join(root, 'huge.json'), 'a'.repeat(1024 * 1024 + 1), { mode: 0o600 });
    await mkdir(join(root, 'dir.json'), { mode: 0o700 });
    const files = await createGoogleOperatorEvidenceFiles(root);
    try { for (const path of ['../private.json', '/private.json', 'link.json', 'public.json', 'huge.json', 'dir.json']) {
      await expect(files.readArtifact(path)).rejects.toThrow('Google processing review unavailable');
    } } finally { await files.close(); }
  });
  it('rejects an evidence directory that grants group access or is a symlink', async () => {
    const root = await folder(); await chmod(root, 0o750);
    await expect(createGoogleOperatorEvidenceFiles(root)).rejects.toThrow('Google processing review unavailable');
    await chmod(root, 0o700); const other = await folder(); await symlink(root, join(other, 'linked'));
    await expect(createGoogleOperatorEvidenceFiles(join(other, 'linked'))).rejects.toThrow('Google processing review unavailable');
  });
});

describe('receipt publication after a committed registry review', () => {
  it.each(['write', 'rename'] as const)('preserves pending bytes when final %s fails after successful DB review', async failure => {
    const root = await folder(), files = await createGoogleOperatorEvidenceFiles(root);
    const receipt = await files.reserveReceipt('receipt.json');
    try {
      const pending = { mode: 'pending', profileId: null, expectedRevision: 0 };
      await receipt.write(pending); const before = await lstat(join(root, 'receipt.json'));
      const reviewProfile = vi.fn(async () => ({ id: '123e4567-e89b-42d3-a456-426614174000', revision: 1 }));
      const reviewed = await reviewProfile(); faults[failure] = true;
      await expect(receipt.write({ mode: 'applied', ...reviewed })).rejects.toThrow('Google processing review unavailable');
      expect(reviewProfile).toHaveBeenCalledOnce();
      expect(await readFile(join(root, 'receipt.json'), 'utf8')).toBe(JSON.stringify(pending));
      const after = await lstat(join(root, 'receipt.json')); expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
    } finally { faults.write = false; faults.rename = false; await receipt.close(); await files.close(); }
  });
  it('refuses a replaced reservation without modifying the foreign file or symlink target', async () => {
    const root = await folder(), files = await createGoogleOperatorEvidenceFiles(root), receipt = await files.reserveReceipt('receipt.json');
    try {
      await receipt.write({ mode: 'pending' }); await unlink(join(root, 'receipt.json'));
      await writeFile(join(root, 'foreign.json'), 'preserve foreign bytes', { mode: 0o600 });
      await symlink(join(root, 'foreign.json'), join(root, 'receipt.json'));
      await expect(receipt.write({ mode: 'applied' })).rejects.toThrow('Google processing review unavailable');
      expect(await readFile(join(root, 'foreign.json'), 'utf8')).toBe('preserve foreign bytes');
    } finally { await receipt.close(); await files.close(); }
  });
});
