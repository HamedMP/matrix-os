import { access, lstat, mkdtemp, rm, mkdir, readFile, readdir, rename, symlink, writeFile, chmod, open, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createNativeProviderWriterLease } from '../../packages/gateway/src/ai-providers/native-provider-writer-lease.js';

const control = vi.hoisted(() => ({
  marker: '', oldStat: undefined as Awaited<ReturnType<typeof lstat>> | undefined,
  gates: [] as Promise<void>[], started: undefined as (() => void) | undefined,
  unlinkCalls: 0, failNext: false, initFailure: '', closeAfterActual: false, closeCalls: 0,
  wrongOwner: '',
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (path: Parameters<typeof lstat>[0]) => {
      const info = path === control.marker && control.oldStat ? control.oldStat : await actual.lstat(path);
      return path === control.wrongOwner ? Object.assign(Object.create(info), { uid: Number(info.uid) + 1 }) : info;
    },
    open: async (...args: Parameters<typeof open>) => {
      const file = await actual.open(...args);
      if (args[0] !== control.marker) return file;
      return new Proxy(file, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return async (...values: unknown[]) => {
          if (key === 'close') control.closeCalls += 1;
          if (key === control.initFailure) {
            control.initFailure = '';
            if (key === 'close' && control.closeAfterActual) await target.close();
            throw Object.assign(new Error('fixture initialization failure'), { code: 'EIO' });
          }
          return Reflect.apply(value, target, values);
        };
      } });
    },
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
const roots: string[] = [];
const privateRoot = (home: string) => join(dirname(home), '.matrix-private', basename(home));
afterEach(async () => {
  control.marker = ''; control.oldStat = undefined; control.gates = [];
  control.started = undefined; control.unlinkCalls = 0; control.failNext = false;
  control.initFailure = ''; control.closeAfterActual = false; control.closeCalls = 0; control.wrongOwner = '';
  await Promise.all(homes.splice(0).flatMap(home => [rm(home, { recursive: true, force: true }), rm(privateRoot(home), { recursive: true, force: true })]));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'writer-release-')); roots.push(root);
  const home = join(root, 'home'); await mkdir(home); homes.push(home);
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
  const link = join(root, ancestor); await mkdir(dirname(link), { recursive: true, mode: 0o700 }); await symlink(target, link);
  await expect(createNativeProviderWriterLease(home).acquire('codex')).rejects.toThrow('lifecycle_unavailable');
  expect(await readdir(target)).toEqual([]);
});

it('rejects a symlink marker while retaining the owner file it points to', async () => {
  const lease = await fixture();
  const target = join(homes[homes.length - 1]!, 'owner-file'); await writeFile(target, 'owner-content');
  await mkdir(dirname(control.marker), { recursive: true, mode: 0o700 }); await symlink(target, control.marker);
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


it.each(['stat', 'writeFile', 'sync', 'close'])('cleans a never-admitted marker after initialization %s fails', async failure => {
  const lease = await fixture(); control.initFailure = failure;
  await expect(lease.acquire('codex')).rejects.toMatchObject({ code: 'EIO' });
  if (failure === 'close') expect(control.closeCalls).toBe(2);
  expect(control.closeCalls).toBeGreaterThan(0);
  await expect(access(control.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  const release = await lease.acquire('codex'); await release();
});
it('cleans a never-admitted marker when close reports failure after closing the descriptor', async () => {
  const lease = await fixture(); control.initFailure = 'close'; control.closeAfterActual = true;
  await expect(lease.acquire('codex')).rejects.toMatchObject({ code: 'EIO' });
  expect(control.closeCalls).toBe(2);
  await expect(access(control.marker)).rejects.toMatchObject({ code: 'ENOENT' });
  const release = await lease.acquire('codex'); await release();
});
it.each(['.matrix-private', '.matrix-private/home', '.matrix-private/home/native-writers'])('rejects permissive existing private directory %s without changing it', async directory => {
  const lease = await fixture(); const home = homes[homes.length - 1]!;
  const path = join(dirname(home), directory); await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o777);
  await expect(lease.acquire('codex')).rejects.toThrow('lifecycle_unavailable');
  expect((await lstat(path)).mode & 0o777).toBe(0o777);
  await expect(access(control.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects an untrusted directory owner before creating a marker', async () => {
  const lease = await fixture(); const directory = privateRoot(homes[homes.length - 1]!);
  await mkdir(directory, { recursive: true, mode: 0o700 }); control.wrongOwner = await realpath(directory);
  await expect(lease.acquire('codex')).rejects.toThrow('lifecycle_unavailable');
  await expect(access(control.marker)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('rejects a replaceable ancestor even when its immediate home parent is private', async () => {
  const root = await mkdtemp(join(tmpdir(), 'writer-ancestor-trust-')); roots.push(root);
  await chmod(root, 0o777);
  const parent = join(root, 'private'); const home = join(parent, 'home'); await mkdir(home, { recursive: true, mode: 0o700 });
  await expect(createNativeProviderWriterLease(home).acquire('codex')).rejects.toThrow('lifecycle_unavailable');
  await expect(access(join(parent, '.matrix-private'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('blocks another instance during a delayed owned release until unlink completes', async () => {
  const lease = await fixture(); const release = await lease.acquire('codex');
  const other = createNativeProviderWriterLease(homes[homes.length - 1]!);
  let resume!: () => void;
  control.gates = [new Promise(resolve => { resume = resolve; })];
  const entered = new Promise<void>(resolve => { control.started = resolve; });
  const closing = release();
  try {
    await entered; await expect(other.acquire('codex')).rejects.toThrow('lifecycle_unavailable');
    resume(); await closing;
    const next = await other.acquire('codex'); await next();
    await release(); await other.assertAvailable('codex');
  } finally { resume(); await closing; }
});

it('preserves initialization error and fences a marker when its cleanup also fails', async () => {
  const lease = await fixture(); control.initFailure = 'sync'; control.failNext = true;
  await expect(lease.acquire('codex')).rejects.toMatchObject({ code: 'EIO' });
  await access(control.marker);
  await expect(lease.assertAvailable('codex')).rejects.toThrow('lifecycle_unavailable');
  await expect(createNativeProviderWriterLease(homes[homes.length - 1]!).acquire('codex')).rejects.toThrow('lifecycle_unavailable');
});

it('rejects an untrusted lexical ancestor even when a symlink resolves to a trusted parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'writer-alias-trust-')); roots.push(root);
  const trusted = join(root, 'trusted'); const shared = join(root, 'shared');
  await mkdir(trusted, { mode: 0o700 }); await mkdir(shared); await chmod(shared, 0o777);
  const alias = join(shared, 'alias'); await symlink(trusted, alias);
  await expect(createNativeProviderWriterLease(join(alias, 'home')).acquire('codex')).rejects.toThrow('lifecycle_unavailable');
  await expect(access(join(trusted, '.matrix-private'))).rejects.toMatchObject({ code: 'ENOENT' });
});
