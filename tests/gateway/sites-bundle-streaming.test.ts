import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const eagerRead = vi.hoisted(() => vi.fn(() => { throw new Error('eager readdir forbidden'); }));
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  readdir: eagerRead,
}));
import { collectSiteFiles } from '../../packages/gateway/src/sites/bundle.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'matrix-sites-streaming-'));
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/index.html'), '<html></html>');
});
afterEach(async () => { eagerRead.mockClear(); await rm(root, { recursive: true, force: true }); });

it('streams directory entries instead of buffering an attacker-sized directory', async () => {
  await expect(collectSiteFiles(root, 'dist')).resolves.toHaveLength(1);
  expect(eagerRead).not.toHaveBeenCalled();
});
