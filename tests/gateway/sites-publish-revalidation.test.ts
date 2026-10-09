import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, mkdir, open, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSiteRoutes } from '../../packages/gateway/src/sites/routes.js';
import { collectSiteFiles } from '../../packages/gateway/src/sites/bundle.js';
import { markAuthContextReady, setPlatformVerifiedPrincipal } from '../../packages/gateway/src/request-principal.js';
vi.mock('../../packages/gateway/src/sites/bundle.js', async importOriginal => {
 const actual = await importOriginal<typeof import('../../packages/gateway/src/sites/bundle.js')>();
 return { ...actual, collectSiteFiles: vi.fn(actual.collectSiteFiles) };
});
const realCollect = (await vi.importActual<typeof import('../../packages/gateway/src/sites/bundle.js')>('../../packages/gateway/src/sites/bundle.js')).collectSiteFiles;
const config = { data: { event: { title: 'Launch', venue: 'Online' }, days: ['Friday', 'Saturday'] }, forms: [] };
let home: string;
let dir: string;
const initial = () => ({ name: 'Event', slug: 'event', version: '1.0.0', runtime: 'vite', runtimeVersion: '1.0.0', scope: 'personal', build: { command: 'pnpm build', output: 'dist' }, publishing: config });
const save = (manifest: unknown) => writeFile(join(dir, 'matrix.json'), JSON.stringify(manifest));
beforeEach(async () => {
 home = await mkdtemp(join(tmpdir(), 'site-publish-revalidation-'));
 dir = join(home, 'apps/event');
 await mkdir(join(dir, 'dist'), { recursive: true });
 await save(initial());
 await writeFile(join(dir, 'dist/index.html'), '<html>Launch</html>');
 vi.mocked(collectSiteFiles).mockReset().mockImplementation(realCollect);
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });
async function publish(duringBuild: () => Promise<void>) {
 const platform = { request: vi.fn().mockResolvedValue({ id: 'site' }) };
 const build = { build: vi.fn(async () => { await duringBuild(); return { ok: true } as const; }) };
 const app = new Hono();
 app.use('*', async (c, next) => { markAuthContextReady(c); setPlatformVerifiedPrincipal(c, 'owner'); await next(); });
 app.route('/', createSiteRoutes({ homePath: home, ownerIds: ['owner'], platform, build, submissions: {} as any }));
 const response = await app.request('/api/apps/event/site', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewedConfig: config }) });
 return { response, platform, build };
}
async function expectConflict(duringBuild: () => Promise<void>) {
 const { response, platform, build } = await publish(duringBuild);
 expect(build.build).toHaveBeenCalledOnce();
 expect(response.status).toBe(409);
 expect(await response.json()).toEqual({ error: 'Site changed; reload and try again' });
 expect(platform.request).not.toHaveBeenCalled();
}
describe('publication manifest checks after asynchronous build/collection', () => {
 it('reads live publishing data even while the app index still caches its old manifest', async () => {
  await expectConflict(() => save({ ...initial(), publishing: { ...config, data: { ...config.data, privateAddress: 'unreviewed' } } }));
  expect(collectSiteFiles).not.toHaveBeenCalled();
 });
 it.each([
  ['forms', { publishing: { ...config, forms: [{ id: 'contact', title: 'Contact', fields: { email: { type: 'email' } } }] } }],
  ['array order', { publishing: { ...config, data: { ...config.data, days: ['Saturday', 'Friday'] } } }],
  ['build command', { build: { ...initial().build, command: 'pnpm other-build' } }],
  ['install command', { build: { ...initial().build, install: 'pnpm different-install' } }],
  ['output', { build: { ...initial().build, output: 'other-dist' } }],
  ['timeout', { build: { ...initial().build, timeout: 30 } }],
  ['source globs', { build: { ...initial().build, sourceGlobs: ['other/**'] } }],
  ['runtime', { runtime: 'static' }],
  ['runtime version', { runtimeVersion: '2.0.0' }],
  ['scope', { scope: 'shared' }],
  ['slug', { slug: 'other' }],
 ])('rejects changes to %s during build', async (_name, change) => {
  await expectConflict(() => save({ ...initial(), ...change }));
  expect(collectSiteFiles).not.toHaveBeenCalled();
 });
 it('rejects an invalid live manifest after build', async () => {
  await expectConflict(() => save({ invalid: true }));
  expect(collectSiteFiles).not.toHaveBeenCalled();
 });
 it('rejects a deleted or oversized live manifest after build', async () => {
  await expectConflict(() => rm(join(dir, 'matrix.json')));
  await save(initial());
  await expectConflict(() => save({ ...initial(), ownerNote: 'x'.repeat(1024 * 1024) }));
 });
 it('promptly rejects a FIFO manifest without leaving a blocked reader behind', async () => {
  const created = Promise.withResolvers<void>();
  const path = join(dir, 'matrix.json');
  const pending = publish(async () => {
   try { await rm(path); await promisify(execFile)('/usr/bin/mkfifo', [path]); }
   finally { created.resolve(); }
  });
  await created.promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prompt = await Promise.race([pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 250); })]);
  if (timer) clearTimeout(timer);
  if (!prompt) {
   // Red-state cleanup pairs the old blocking reader with a nonblocking writer.
   // It never starts another blocked open and awaits the reader before unlinking.
   let writer: Awaited<ReturnType<typeof open>> | undefined;
   for (let attempt = 0; attempt < 100 && !writer; attempt++) {
    try { writer = await open(path, constants.O_WRONLY | constants.O_NONBLOCK); }
    catch (error) {
     if ((error as NodeJS.ErrnoException).code !== 'ENXIO') throw error;
     await new Promise(resolve => setTimeout(resolve, 10));
    }
   }
   if (!writer) throw new Error('FIFO cleanup writer unavailable');
   await writer.close();
  }
  const { response, platform } = prompt ?? await pending;
  expect(prompt).not.toBeNull();
  expect(response.status).toBe(409);
  expect(collectSiteFiles).not.toHaveBeenCalled();
  expect(platform.request).not.toHaveBeenCalled();
 });
 it('rejects a different directory recreated at the same pathname', async () => {
  await expectConflict(async () => {
   await rename(dir, dir + '-original');
   await mkdir(join(dir, 'dist'), { recursive: true });
   await save(initial());
   await writeFile(join(dir, 'dist/index.html'), '<html>Replacement</html>');
  });
  expect(collectSiteFiles).not.toHaveBeenCalled();
 });
 it('rechecks publishing after asynchronous artifact collection', async () => {
  vi.mocked(collectSiteFiles).mockImplementation(async (...args) => {
   const files = await realCollect(...args);
   await save({ ...initial(), publishing: { ...config, data: { unreviewed: true } } });
   return files;
  });
  await expectConflict(async () => {});
  expect(collectSiteFiles).toHaveBeenCalledOnce();
 });
 it('rejects replacing the app directory with a different artifact producer during build', async () => {
  await expectConflict(async () => {
   const other = join(home, 'apps/other');
   await mkdir(join(other, 'dist'), { recursive: true });
   await writeFile(join(other, 'matrix.json'), JSON.stringify(initial()));
   await writeFile(join(other, 'dist/index.html'), '<html>Other app</html>');
   await rename(dir, dir + '-original');
   await symlink(other, dir);
  });
  expect(collectSiteFiles).not.toHaveBeenCalled();
 });
 it('allows equivalent parsed object ordering/defaults and unrelated metadata changes', async () => {
  const { response, platform } = await publish(() => save({ ...initial(), name: 'Renamed', icon: 'updated', version: '1.0.1', build: { output: 'dist', command: 'pnpm build', timeout: 120 }, publishing: { forms: [], data: { days: ['Friday', 'Saturday'], event: { venue: 'Online', title: 'Launch' } } } }));
  expect(response.status).toBe(200);
  expect(platform.request).toHaveBeenCalledOnce();
 });
});
