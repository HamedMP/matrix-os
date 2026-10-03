import { access, lstat, mkdtemp, rm, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeProviderWriterLease } from '../../packages/gateway/src/ai-providers/native-provider-writer-lease.js';

const control = vi.hoisted(() => ({
  marker: '', oldStat: undefined as Awaited<ReturnType<typeof lstat>> | undefined,
  gates: [] as Promise<void>[], started: undefined as (() => void) | undefined,
  unlinkCalls: 0, failNext: false,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: (path: Parameters<typeof lstat>[0]) => path === control.marker && control.oldStat
      ? Promise.resolve(control.oldStat) : actual.lstat(path),
    unlink: async (path: string) => {
      if (path === control.marker) {
        const gate = control.gates[control.unlinkCalls++];
        control.started?.();
        if (gate) await gate;
        if (control.failNext) { control.failNext = false; throw Object.assign(new Error('fixture unlink failure'), { code: 'EACCES' }); }
      }
      return actual.unlink(path);
    },
  };
});
const homes: string[] = [];
const privateRoot = (home: string) => join(dirname(home), '.matrix-private', basename(home));
afterEach(async () => {
  control.marker = ''; control.oldStat = undefined; control.gates = [];
  control.started = undefined; control.unlinkCalls = 0; control.failNext = false;
  await Promise.all(homes.splice(0).flatMap(home => [rm(home, { recursive: true, force: true }), rm(privateRoot(home), { recursive: true, force: true })]));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'writer-release-')); homes.push(home);
  control.marker = join(privateRoot(home), 'native-writers/codex.json');
  return createNativeProviderWriterLease(home);
}
it('coalesces concurrent release so a late unlink cannot delete a newly admitted writer', async () => {
  const lease = await fixture(); const release = await lease.acquire('codex');
  // Both original release calls can validate the same old inode before either
  // unlink finishes. Hold the two unlinks to reproduce that exact ordering.
  control.oldStat = await lstat(control.marker);
  let releaseFirst!: () => void; let releaseSecond!: () => void;
  control.gates = [new Promise(resolve => { releaseFirst = resolve; }), new Promise(resolve => { releaseSecond = resolve; })];
  const entered = new Promise<void>(resolve => { control.started = resolve; });
  const first = release(); const second = release();
  try {
    await entered; control.oldStat = undefined;
    releaseFirst(); await Promise.race([first, second]);
    const replacementRelease = await lease.acquire('codex');
    await access(control.marker);
    releaseSecond(); await Promise.all([first, second]);
    await access(control.marker);
    await expect(lease.assertAvailable('codex')).rejects.toThrow('lifecycle_unavailable');
    expect(control.unlinkCalls).toBe(1);
    await replacementRelease();
  } finally { releaseFirst(); releaseSecond(); await Promise.allSettled([first, second]); }
});
it('retains failed admission and permits release retry only after confirmed unlink', async () => {
  const lease = await fixture(); const release = await lease.acquire('codex');
  control.failNext = true;
  const failed = await Promise.allSettled([release(), release()]);
  expect(failed.every(result => result.status === 'rejected')).toBe(true);
  expect(control.unlinkCalls).toBe(1);
  await access(control.marker);
  await expect(lease.assertAvailable('codex')).rejects.toThrow('lifecycle_unavailable');
  await release(); await lease.assertAvailable('codex');
  expect(control.unlinkCalls).toBe(2);
});


it('admits only one instance per profile and keeps markers outside synced owner files', async () => {
  const lease = await fixture();
  const home = homes[homes.length - 1]!;
  const contenders = await Promise.allSettled([lease.acquire('codex'), createNativeProviderWriterLease(home).acquire('codex')]);
  expect(contenders.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(contenders.filter(result => result.status === 'rejected')).toHaveLength(1);
  await expect(createNativeProviderWriterLease(home).assertAvailable('codex')).rejects.toThrow('lifecycle_unavailable');
  await expect(access(join(home, 'system/ai-providers/native-writers'))).rejects.toMatchObject({ code: 'ENOENT' });
  const marker = await readFile(control.marker, 'utf8');
  expect(JSON.parse(marker)).toMatchObject({ version: 1, profile: 'codex' });
  expect(marker).not.toMatch(/"(?:token|code|secret|account)"\s*:/);
  const independent = await createNativeProviderWriterLease(home).acquire('claude');
  await independent();
  const winner = contenders.find(result => result.status === 'fulfilled');
  if (winner?.status !== 'fulfilled') throw new Error('Missing admitted writer');
  await winner.value();
  const next = await createNativeProviderWriterLease(home).acquire('codex'); await next();
});

it.each(['.matrix-private', '.matrix-private/home', '.matrix-private/home/native-writers'])('rejects symlinked admission ancestor %s without writing its target', async ancestor => {
  const root = await mkdtemp(join(tmpdir(), 'writer-ancestor-')); homes.push(root);
  const home = join(root, 'home'); const target = join(root, 'target');
  await mkdir(home); await mkdir(target);
  const link = join(root, ancestor); await mkdir(dirname(link), { recursive: true }); await symlink(target, link);
  await expect(createNativeProviderWriterLease(home).acquire('codex')).rejects.toThrow('lifecycle_unavailable');
  expect(await readdir(target)).toEqual([]);
});

it('rejects a symlink marker while retaining the owner file it points to', async () => {
  const lease = await fixture();
  const target = join(homes[homes.length - 1]!, 'owner-file'); await writeFile(target, 'owner-content');
  await mkdir(dirname(control.marker), { recursive: true }); await symlink(target, control.marker);
  await expect(lease.acquire('codex')).rejects.toThrow('lifecycle_unavailable');
  await expect(lease.assertAvailable('codex')).rejects.toThrow('lifecycle_unavailable');
  expect(await readFile(target, 'utf8')).toBe('owner-content');
});

it('never releases a replacement marker with a different ownership identity', async () => {
  const lease = await fixture(); const release = await lease.acquire('codex');
  const original = `${control.marker}.original`;
  await rename(control.marker, original); await writeFile(control.marker, 'replacement-admission');
  await expect(release()).rejects.toThrow('lifecycle_unavailable');
  expect(await readFile(control.marker, 'utf8')).toBe('replacement-admission');
  await expect(createNativeProviderWriterLease(homes[homes.length - 1]!).acquire('codex')).rejects.toThrow('lifecycle_unavailable');
  await rm(control.marker); await rename(original, control.marker);
  await release(); await lease.assertAvailable('codex');
});
