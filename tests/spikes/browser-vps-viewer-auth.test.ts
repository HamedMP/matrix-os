import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { writeViewerAuthorization } from '../../scripts/spikes/browser-vps/viewer-auth.mjs';
describe('test viewer credential persistence', () => {
  it('preserves the runtime environment owner and group-readable permissions across atomic replacement', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'matrix-viewer-auth-'));
    const path = join(directory, 'host.env');
    try {
      await writeFile(path, 'MATRIX_HANDLE=pr-1\nMATRIX_BROWSER_LAB_VIEWER_AUTH="Basic old"\n', { mode: 0o640 });
      const before = await stat(path);
      await writeViewerAuthorization(path, 'Basic c3ludGhldGljOm9ubHk=');
      const after = await stat(path);
      expect(after.mode & 0o777).toBe(0o640);
      expect([after.uid, after.gid]).toEqual([before.uid, before.gid]);
      const data = await readFile(path, 'utf8');
      expect(data).toContain('MATRIX_HANDLE=pr-1');
      expect(data.match(/MATRIX_BROWSER_LAB_VIEWER_AUTH=/g)).toHaveLength(1);
      expect(data).not.toContain('Basic old');
      expect(data).toContain('SHELL_ORIGIN=https://app.matrix-os.com');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('keeps an explicitly configured shell origin', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'matrix-viewer-origin-'));
    const path = join(directory, 'host.env');
    try {
      await writeFile(path, 'SHELL_ORIGIN=https://configured.example\n', { mode: 0o640 });
      await writeViewerAuthorization(path, 'Basic c3ludGhldGljOm9ubHk=');
      expect(await readFile(path, 'utf8')).toContain('SHELL_ORIGIN=https://configured.example');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
