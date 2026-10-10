import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BuildError } from '../../../packages/gateway/src/app-runtime/errors.js';
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'app-build-lock-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe('bounded shared build ownership', () => {
 it('serializes aliases and releases both failure paths without retaining queued callbacks', async () => {
  const { withAppBuildLock } = await import('../../../packages/gateway/src/app-runtime/build-lock.js');
  const app = join(root, 'app'); const alias = join(root, 'alias'); await mkdir(app); await symlink(app, alias);
  const started = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>(); const next = vi.fn();
  const first = withAppBuildLock(app, async () => { started.resolve(); await resume.promise; throw new Error('Capture failed'); });
  const firstFailure = first.catch(error => error); await started.promise;
  const second = withAppBuildLock(alias, async () => { next(); });
  try { await new Promise(resolve => setTimeout(resolve, 20)); expect(next).not.toHaveBeenCalled(); }
  finally { resume.resolve(); }
  expect(await firstFailure).toMatchObject({ message: 'Capture failed' }); await second;
  expect(next).toHaveBeenCalledOnce();
  await expect(withAppBuildLock(app, async () => 'later')).resolves.toBe('later');
 });
 it('bounds queued callers per directory and releases capacity when they settle', async () => {
  const { withAppBuildLock } = await import('../../../packages/gateway/src/app-runtime/build-lock.js');
  const app = join(root, 'app'); await mkdir(app);
  const resume = Promise.withResolvers<void>(); const errors: unknown[] = []; let captures = 0;
  const requests = Array.from({ length: 20 }, () => withAppBuildLock(app, async () => { captures++; await resume.promise; }).catch(error => { errors.push(error); }));
  try { await vi.waitFor(() => expect(errors).toHaveLength(3)); }
  finally { resume.resolve(); await Promise.all(requests); }
  expect(captures).toBe(17); for (const error of errors) expect(error).toBeInstanceOf(BuildError);
  await expect(withAppBuildLock(app, async () => 'later')).resolves.toBe('later');
 });
 it('bounds live directory keys and evicts all settled keys immediately', async () => {
  const { withAppBuildLock } = await import('../../../packages/gateway/src/app-runtime/build-lock.js');
  const directories = Array.from({ length: 129 }, (_, id) => join(root, String(id)));
  await Promise.all(directories.map(dir => mkdir(dir)));
  const resume = Promise.withResolvers<void>(); let captures = 0;
  const requests = directories.slice(0, 128).map(dir => withAppBuildLock(dir, async () => { captures++; await resume.promise; }));
  try {
   await vi.waitFor(() => expect(captures).toBe(128));
   await expect(withAppBuildLock(directories[128], async () => {})).rejects.toBeInstanceOf(BuildError);
  } finally { resume.resolve(); await Promise.all(requests); }
  await expect(withAppBuildLock(directories[128], async () => 'later')).resolves.toBe('later');
 });
});
