import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BuildOrchestrator } from '../../../packages/gateway/src/app-runtime/build-orchestrator.js';
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
});
