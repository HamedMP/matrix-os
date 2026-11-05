import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { BuildOrchestrator } from '../../../packages/gateway/src/app-runtime/build-orchestrator.js';
import { ImmutableCollaborativeBuildStore } from '../../../packages/gateway/src/app-runtime/build-cache.js';
let root: string; let dir: string;
beforeEach(async () => {
 root = await mkdtemp(join(tmpdir(), 'build-snapshot-')); dir = join(root, 'app'); await mkdir(dir);
 await writeFile(join(dir, 'matrix.json'), JSON.stringify({ name: 'App', slug: 'app', version: '1.0.0', runtime: 'vite', runtimeVersion: '1.0.0', build: { install: 'node -e "process.exit(0)"', command: 'node build.mjs', output: 'dist', sourceGlobs: ['input.txt', 'matrix.json'] } }));
 await writeFile(join(dir, 'input.txt'), 'first');
 await writeFile(join(dir, 'build.mjs'), `import {mkdir,readFile,writeFile} from 'node:fs/promises';await mkdir('dist',{recursive:true});await writeFile('dist/index.html',await readFile('input.txt','utf8'));`);
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });
describe('BuildOrchestrator immutable capture', () => {
 it('runs the collector after a successful build', async () => {
  const collector = vi.fn(() => readFile(join(dir, 'dist/index.html'), 'utf8'));
  const result = await (new BuildOrchestrator({ concurrency: 1 }) as any).buildWithSnapshot('app', dir, {}, collector);
  expect(result).toMatchObject({ ok: true, snapshot: 'first' }); expect(collector).toHaveBeenCalledOnce();
 });
 it('does not invoke the collector for a failed build', async () => {
  await writeFile(join(dir, 'matrix.json'), JSON.stringify({ name: 'App', slug: 'app', version: '1.0.0', runtime: 'vite', runtimeVersion: '1.0.0', build: { install: 'node -e "process.exit(3)"', command: 'node build.mjs', output: 'dist' } }));
  const collector = vi.fn();
  expect(await (new BuildOrchestrator({ concurrency: 1 }) as any).buildWithSnapshot('app', dir, {}, collector)).toMatchObject({ ok: false });
  expect(collector).not.toHaveBeenCalled();
 });
 it('releases a failed collector for another instance and canonical directory alias', async () => {
  const alias = join(root, 'alias'); await symlink(dir, alias);
  await expect((new BuildOrchestrator({ concurrency: 1 }) as any).buildWithSnapshot('app', dir, {}, async () => { throw new Error('Collector failed'); })).rejects.toThrow('Collector failed');
  await writeFile(join(dir, 'input.txt'), 'second');
  expect((await new BuildOrchestrator({ concurrency: 1 }).build('app', alias)).ok).toBe(true);
  expect(await readFile(join(dir, 'dist/index.html'), 'utf8')).toBe('second');
 });
 it('preserves ordinary concurrent-build coalescing', async () => {
  const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
  const orch = new BuildOrchestrator({ concurrency: 1 }); const original = (orch as any).doBuild.bind(orch);
  const build = vi.spyOn(orch as any, 'doBuild').mockImplementation(async (...args) => { entered.resolve(); await resume.promise; return original(...args); });
  const requests = [orch.build('app', dir), orch.build('app', dir)];
  try { await entered.promise; expect(build).toHaveBeenCalledOnce(); }
  finally { resume.resolve(); }
  const results = await Promise.all(requests); expect(results[0]).toBe(results[1]);
 });
 it('shares one absolute deadline across install and build', async () => {
  await writeFile(join(dir, 'matrix.json'), JSON.stringify({ name: 'App', slug: 'app', version: '1.0.0', runtime: 'vite', runtimeVersion: '1.0.0', build: {
   install: 'node -e "setTimeout(()=>process.exit(0),100)"', command: 'node -e "setTimeout(()=>process.exit(0),100)"', output: 'dist', sourceGlobs: ['input.txt', 'matrix.json'],
  } }));
  const collector = vi.fn(); const started = Date.now();
  const result = await new BuildOrchestrator({ concurrency: 1 }).buildWithSnapshot('app', dir, { deadlineAt: started + 150 }, collector);
  expect(result).toMatchObject({ ok: false, error: { code: 'timeout' } });
  expect(collector).not.toHaveBeenCalled(); expect(Date.now() - started).toBeLessThan(350);
 });
 it('captures the manifest output under the build lock and derives its final id from exact bytes', async () => {
  const store = new ImmutableCollaborativeBuildStore({ rootDir: join(root, 'store'), maxSnapshots: 4, retentionMs: 60_000, cleanupIntervalMs: 60_000 });
  try {
   const result = await new BuildOrchestrator({ concurrency: 1 }).buildWithCollaborativeSnapshot('app', dir, {
    store,
    buildIdForAssetDigest: (assetDigest) => createHash('sha256').update(`identity:${assetDigest}`).digest('hex'),
   });
   expect(result).toMatchObject({ ok: true, snapshot: { assetDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
   if (!result.ok) throw result.error;
   expect(result.snapshot.buildId).toBe(createHash("sha256")
    .update(`identity:${result.snapshot.assetDigest}`).digest("hex"));
   expect(await readFile(join(result.snapshot.artifactPath, 'index.html'), 'utf8')).toBe('first');
  } finally { await store.close(); }
 });
});
