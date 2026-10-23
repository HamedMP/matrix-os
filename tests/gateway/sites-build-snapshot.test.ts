import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BuildOrchestrator } from '../../packages/gateway/src/app-runtime/build-orchestrator.js';
import { createSiteRoutes } from '../../packages/gateway/src/sites/routes.js';
import { collectSiteFiles } from '../../packages/gateway/src/sites/bundle.js';
import { markAuthContextReady, setPlatformVerifiedPrincipal } from '../../packages/gateway/src/request-principal.js';
vi.mock('../../packages/gateway/src/sites/bundle.js', async importOriginal => {
 const actual = await importOriginal<typeof import('../../packages/gateway/src/sites/bundle.js')>();
 return { ...actual, collectSiteFiles: vi.fn(actual.collectSiteFiles) };
});
let home: string;
let dir: string;
beforeEach(async () => {
 home = await mkdtemp(join(tmpdir(), 'sites-build-snapshot-')); dir = join(home, 'apps/event');
 await mkdir(dir, { recursive: true });
 await writeFile(join(dir, 'matrix.json'), JSON.stringify({ name: 'Event', slug: 'event', version: '1.0.0', runtime: 'vite', runtimeVersion: '1.0.0', publishing: {}, build: { install: 'node -e "process.exit(0)"', command: 'node build.mjs', output: 'dist', sourceGlobs: ['input.txt', 'build.mjs', 'matrix.json'] } }));
 await writeFile(join(dir, 'input.txt'), 'first');
 await writeFile(join(dir, 'build.mjs'), `import {mkdir,readFile,writeFile} from 'node:fs/promises';const generation=await readFile('input.txt','utf8');await mkdir('dist',{recursive:true});await writeFile('dist/index.html','<html>'+generation+'</html>');await writeFile('dist/style.css','/*'+generation+'*/');`);
});
afterEach(async () => { vi.mocked(collectSiteFiles).mockReset(); await rm(home, { recursive: true, force: true }); });
it('keeps a separate ordinary build from rewriting dist until public bytes finish collection', async () => {
 const collecting = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
 vi.mocked(collectSiteFiles).mockImplementation(async (appDir: string) => {
  const first = await readFile(join(appDir, 'dist/index.html'));
  collecting.resolve(); await resume.promise;
  const second = await readFile(join(appDir, 'dist/style.css'));
  return [{ path: 'index.html', contentType: 'text/html', body: first.toString('base64') }, { path: 'style.css', contentType: 'text/css', body: second.toString('base64') }];
 });
 const platform = { request: vi.fn(async (_slug: string, _method: string, _body: any) => ({ id: 'site' })) };
 const app = new Hono(); app.use('*', async (c, next) => { markAuthContextReady(c); setPlatformVerifiedPrincipal(c, 'owner'); await next(); });
 app.route('/', createSiteRoutes({ homePath: home, ownerIds: ['owner'], platform, submissions: null }));
 const publishing = app.request('/api/apps/event/site', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewedConfig: {} }) });
 let ordinary: Promise<unknown> | undefined;
 try {
  await vi.waitFor(() => expect(collectSiteFiles).toHaveBeenCalledOnce(), { timeout: 5000 }); await collecting.promise;
  await writeFile(join(dir, 'input.txt'), 'second');
  ordinary = new BuildOrchestrator({ concurrency: 1 }).build('event', dir);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const state = await Promise.race([ordinary.then(() => 'finished'), new Promise<string>(resolve => { timer = setTimeout(() => resolve('pending'), 1000); })]);
  if (timer) clearTimeout(timer);
  resume.resolve();
  expect((await publishing).status).toBe(200); await ordinary;
  const files = platform.request.mock.calls[0][2].files;
  expect(files.map((file: { body: string }) => Buffer.from(file.body, 'base64').toString())).toEqual(['<html>first</html>', '/*first*/']);
  expect(state).toBe('pending');
  expect(await readFile(join(dir, 'dist/style.css'), 'utf8')).toBe('/*second*/');
 } finally { resume.resolve(); await Promise.allSettled([publishing, ...(ordinary ? [ordinary] : [])]); }
}, 15000);
