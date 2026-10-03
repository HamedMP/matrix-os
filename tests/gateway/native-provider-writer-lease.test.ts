import { mkdtemp, rm, readFile, symlink, writeFile, mkdir, access, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeProviderProfileGuard } from '../../packages/gateway/src/ai-providers/native-provider-profile-guard.js';
const homes: string[] = [];
const privateRoot = (home: string) => join(dirname(home), '.matrix-private', basename(home));
afterEach(async () => { await Promise.all(homes.splice(0).flatMap(home => [rm(home, { recursive: true, force: true }), rm(privateRoot(home), { recursive: true, force: true })])); });
const registry = { get: async () => { throw Object.assign(new Error('missing'), { code: 'session_not_found' }); }, observeAgentLiveness: async () => 'stopped' as const };
it('fences unresolved direct writers across service restart until confirmed release', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'writer-lease-')); homes.push(homePath);
  const release = await createNativeProviderProfileGuard({ homePath, registry }).acquire('codex', { kind: 'write', durable: true });
  const restarted = createNativeProviderProfileGuard({ homePath, registry });
  await expect(restarted.acquire('codex', { kind: 'write' })).rejects.toThrow('lifecycle_unavailable');
  const marker = await readFile(join(privateRoot(homePath), 'native-writers/codex.json'), 'utf8');
  expect(JSON.parse(marker)).toMatchObject({ version: 1, profile: 'codex' });
  expect(marker).not.toMatch(/"(?:token|code|secret)"\s*:/);
  await release();
  const next = await restarted.acquire('codex', { kind: 'write' }); await next();
});
it('never replaces a symlink marker or deletes another owner file', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'writer-lease-')); homes.push(homePath);
  const target = join(homePath, 'owner-file'); await writeFile(target, 'keep');
  const directory = join(privateRoot(homePath), 'native-writers'); await mkdir(directory, { recursive: true });
  await symlink(target, join(directory, 'claude.json'));
  await expect(createNativeProviderProfileGuard({ homePath, registry }).acquire('claude', { kind: 'write', durable: true })).rejects.toThrow('lifecycle_unavailable');
  expect(await readFile(target, 'utf8')).toBe('keep');
});

it('retains durable admission after an ambiguous singleton save failure', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'writer-lease-')); homes.push(homePath);
  const guard = createNativeProviderProfileGuard({ homePath, registry });
  const { createProviderKeyVerifier } = await import('../../packages/gateway/src/ai-providers/provider-workflow-key.js');
  const verify = createProviderKeyVerifier({ providerId: 'openai', profileGuard: guard, profile: 'codex', fetchFn: async () => new Response('', { status: 200 }), save: async () => { throw new Error('writer state unknown'); } });
  await expect(verify({ harnessInstanceId: 'codex', providerId: 'openai', apiKey: 'fixture-only' })).rejects.toThrow('writer state unknown');
  await expect(createNativeProviderProfileGuard({ homePath, registry }).acquire('codex', { kind: 'write' })).rejects.toThrow('lifecycle_unavailable');
});

it('rejects symlinked admission parents without creating files in their target', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'writer-lease-')); homes.push(homePath);
  const target = await mkdtemp(join(tmpdir(), 'writer-target-')); homes.push(target);
  await mkdir(dirname(privateRoot(homePath)), { recursive: true });
  await symlink(target, privateRoot(homePath));
  await expect(createNativeProviderProfileGuard({ homePath, registry }).acquire('codex', { kind: 'write', durable: true })).rejects.toThrow('lifecycle_unavailable');
  expect(await readdir(target)).toEqual([]);
});

it('isolates runtime admissions from another owner home and synced owner files', async () => {
  const first = await mkdtemp(join(tmpdir(), 'writer-lease-')); homes.push(first);
  const second = await mkdtemp(join(tmpdir(), 'writer-lease-')); homes.push(second);
  const release = await createNativeProviderProfileGuard({ homePath: first, registry }).acquire('codex', { kind: 'write', durable: true });
  await expect(access(join(first, 'system/ai-providers/native-writers'))).rejects.toMatchObject({ code: 'ENOENT' });
  const secondRelease = await createNativeProviderProfileGuard({ homePath: second, registry }).acquire('codex', { kind: 'write', durable: true });
  expect(privateRoot(first)).not.toBe(privateRoot(second));
  await secondRelease(); await release();
});


it('releases admission when the real Codex saver proves CODEX_HOME preflight started no writer', async () => {
  const homePath = await mkdtemp(join(tmpdir(), 'writer-lease-')); homes.push(homePath);
  const { createProviderKeyVerifier, createCodexKeySaver } = await import('../../packages/gateway/src/ai-providers/provider-workflow-key.js');
  const guard = createNativeProviderProfileGuard({ homePath, registry });
  vi.stubEnv('CODEX_HOME', join(homePath, 'different-profile'));
  try {
    const verify = createProviderKeyVerifier({ providerId: 'openai', profileGuard: guard, profile: 'codex', fetchFn: async () => new Response('', { status: 200 }), save: createCodexKeySaver({ homePath }) });
    await expect(verify({ harnessInstanceId: 'codex', providerId: 'openai', apiKey: 'fixture-only' })).rejects.toThrow('unavailable');
    await expect(access(join(homePath, '.codex'))).rejects.toMatchObject({ code: 'ENOENT' });
    const release = await guard.acquire('codex', { kind: 'write' }); await release();
    const restartedRelease = await createNativeProviderProfileGuard({ homePath, registry }).acquire('codex', { kind: 'write' }); await restartedRelease();
  } finally { vi.unstubAllEnvs(); }
});
