import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, mkdir, writeFile, symlink, link } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlanDiagnosticStore, planDiagnosticDirectory } from '../../desktop/src/main/chatgpt-plan/diagnostic-store';
import { logPlanFailure, PlanFailure } from '../../desktop/src/main/chatgpt-plan/diagnostics';

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));
const directories: string[] = [];
const stores: ReturnType<typeof createPlanDiagnosticStore>[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks(); vi.useRealTimers();
});
async function setup(options: Parameters<typeof createPlanDiagnosticStore>[0] = { directory: '' }) {
  const parent = await mkdtemp(join(tmpdir(), 'matrix-plan-diagnostics-')); directories.push(parent);
  const directory = join(parent, 'diagnostics');
  const store = createPlanDiagnosticStore({ ...options, directory }); stores.push(store);
  return { directory, store, file: join(directory, 'chatgpt-plan-failures.json') };
}
it('persists only fixed failure metadata in a private app-owned file, independently of console output', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { directory, store, file } = await setup();
  logPlanFailure('responses', new PlanFailure('responses', 'incomplete_stream', 200), {
    requestId: '10000000-0000-4000-8000-000000000001', runId: 'run_1234567890abcdef1234567890abcdef',
    computerId: '30000000-0000-4000-8000-000000000001', body: 'SECRET BODY', token: 'SECRET TOKEN', path: '/PRIVATE', accountId: 'PRIVATE ACCOUNT',
  });
  await store.flush();
  const text = await readFile(file, 'utf8'); const rows = JSON.parse(text);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), stage: 'responses', category: 'incomplete_stream', httpStatus: 200,
    correlation: { requestId: '10000000-0000-4000-8000-000000000001', runId: 'run_1234567890abcdef1234567890abcdef', computerId: '30000000-0000-4000-8000-000000000001' } });
  expect(text).not.toMatch(/SECRET|PRIVATE|body|token|accountId|path/);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
});

it('removes expired records at startup without requiring another failure', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const parent = await mkdtemp(join(tmpdir(), 'matrix-plan-diagnostics-')); directories.push(parent);
  const directory = join(parent, 'diagnostics'); await mkdir(directory, { mode: 0o700 });
  const file = join(directory, 'chatgpt-plan-failures.json');
  await writeFile(file, JSON.stringify([{ observedAt: '2026-10-20T00:00:00.000Z', stage: 'responses', category: 'timeout' }]), { mode: 0o600 });
  const store = createPlanDiagnosticStore({ directory, now: () => Date.parse('2026-10-22T00:00:00.000Z') }); stores.push(store);
  await store.flush();
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([]);
});
it('reports a failed disk write without throwing through logPlanFailure or claiming a successful flush', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const parent = await mkdtemp(join(tmpdir(), 'matrix-plan-diagnostics-')); directories.push(parent);
  const directory = join(parent, 'not-a-directory'); await writeFile(directory, 'unchanged');
  const store = createPlanDiagnosticStore({ directory }); stores.push(store);
  expect(() => logPlanFailure('peer_reply', new DOMException('SECRET ERROR', 'TimeoutError'))).not.toThrow();
  expect(await store.flush()).toBe(false);
  expect(await readFile(directory, 'utf8')).toBe('unchanged');
});
it('retains failed writes for a later flush without retrying continuously', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const actualRename = fs.rename;
  const rename = vi.spyOn(fs, 'rename').mockRejectedValue(Object.assign(new Error('Write unavailable'), { code: 'EIO' }));
  const { store, file } = await setup();
  logPlanFailure('responses', new DOMException('SECRET', 'TimeoutError'));
  expect(await store.flush()).toBe(false);
  expect(rename).toHaveBeenCalledTimes(1);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(rename).toHaveBeenCalledTimes(1);
  rename.mockImplementation(actualRename);
  expect(await store.flush()).toBe(true);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([
    expect.objectContaining({ stage: 'responses', category: 'timeout' }),
  ]);
  expect(rename).toHaveBeenCalledTimes(2);
});
it('stops accepting records and makes later flush harmless after bounded close', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { store, file } = await setup();
  logPlanFailure('responses', new DOMException('SECRET', 'TimeoutError'));
  expect(await store.close()).toBe(true);
  logPlanFailure('responses', new Error('SECRET AFTER CLOSE'));
  await expect(store.flush()).resolves.toBe(false);
  expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(1);
});

it('isolates different app profiles beneath the app logs directory without writing profile paths into records', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const parent = await mkdtemp(join(tmpdir(), 'matrix-plan-diagnostics-')); directories.push(parent);
  const firstDirectory = planDiagnosticDirectory(parent, '/PRIVATE/qa-profile');
  const secondDirectory = planDiagnosticDirectory(parent, '/PRIVATE/stable-profile');
  expect(firstDirectory).not.toBe(secondDirectory);
  const first = createPlanDiagnosticStore({ directory: firstDirectory }); stores.push(first);
  logPlanFailure('peer_reply', new DOMException('SECRET', 'TimeoutError')); await first.close();
  const second = createPlanDiagnosticStore({ directory: secondDirectory }); stores.push(second);
  logPlanFailure('peer_poll', new DOMException('SECRET', 'TimeoutError')); await second.close();
  const firstText = await readFile(join(firstDirectory, 'chatgpt-plan-failures.json'), 'utf8');
  const secondText = await readFile(join(secondDirectory, 'chatgpt-plan-failures.json'), 'utf8');
  expect(JSON.parse(firstText).map((row: {stage:string}) => row.stage)).toEqual(['peer_reply']);
  expect(JSON.parse(secondText).map((row: {stage:string}) => row.stage)).toEqual(['peer_poll']);
  expect(firstText + secondText).not.toMatch(/PRIVATE|qa-profile|stable-profile/);
});
it('refuses a symlinked logs parent without creating or changing files outside the owned directory', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const parent = await mkdtemp(join(tmpdir(), 'matrix-plan-diagnostics-')); directories.push(parent);
  const outside = join(parent, 'outside'); await mkdir(outside);
  const linked = join(parent, 'linked-logs'); await symlink(outside, linked);
  const store = createPlanDiagnosticStore({ directory: join(linked, 'profile') }); stores.push(store);
  logPlanFailure('peer_poll', new DOMException('SECRET', 'TimeoutError'));
  expect(await store.flush()).toBe(false);
  await expect(stat(join(outside, 'profile', 'chatgpt-plan-failures.json'))).rejects.toHaveProperty('code', 'ENOENT');
});

it('runs startup expiry cleanup without a new failure or an explicit flush', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const parent = await mkdtemp(join(tmpdir(), 'matrix-plan-diagnostics-')); directories.push(parent);
  const directory = join(parent, 'diagnostics'); await mkdir(directory, { mode: 0o700 });
  const file = join(directory, 'chatgpt-plan-failures.json');
  await writeFile(file, JSON.stringify([{ observedAt: '2026-10-20T00:00:00.000Z', stage: 'responses', category: 'timeout' }]), { mode: 0o600 });
  const store = createPlanDiagnosticStore({ directory, now: () => Date.parse('2026-10-22T00:00:00.000Z') }); stores.push(store);
  await vi.waitFor(async () => expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([]), { timeout: 200 });
});
it('keeps the latest 128 records and bounds the persisted snapshot even while the writer is stalled', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const actualRename = fs.rename;
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => { entered(); await waiting; return actualRename(...args); });
  const { store, file } = await setup();
  logPlanFailure('responses', new DOMException('SECRET', 'TimeoutError'));
  await started;
  for (let index = 0; index < 300; index++) logPlanFailure('peer_reply', new DOMException('SECRET', 'TimeoutError'), { runId: 'run_' + index.toString(16).padStart(32, '0') });
  expect(rename).toHaveBeenCalledTimes(1);
  release(); expect(await store.flush()).toBe(true);
  const text = await readFile(file, 'utf8'); const rows = JSON.parse(text);
  expect(rows).toHaveLength(128); expect(Buffer.byteLength(text)).toBeLessThanOrEqual(65536);
  expect(rows[0].correlation.runId).toBe('run_000000000000000000000000000000ac');
  expect(rows[127].correlation.runId).toBe('run_0000000000000000000000000000012b');
});
it('stores safe fallbacks for arbitrary PlanFailure strings and drops invalid statuses and identifiers', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { store, file } = await setup();
  logPlanFailure('PRIVATE PATH', new PlanFailure('SECRET STAGE', 'SECRET CATEGORY', Number.NaN), { requestId: '/PRIVATE', runId: 'run_private', accountId: 'SECRET ACCOUNT' });
  await store.flush();
  const text = await readFile(file, 'utf8'); const rows = JSON.parse(text);
  expect(rows[0]).toEqual({ observedAt: expect.any(String), stage: 'other', category: 'local_failure' });
  expect(text).not.toMatch(/PRIVATE|SECRET|run_private|httpStatus|correlation/);
});
it.each(['symlink', 'hardlink'] as const)('does not overwrite or follow a %s at the fixed log file', async kind => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const parent = await mkdtemp(join(tmpdir(), 'matrix-plan-diagnostics-')); directories.push(parent);
  const directory = join(parent, 'diagnostics'); await mkdir(directory, { mode: 0o700 });
  const outside = join(parent, 'outside'); await writeFile(outside, 'KEEP');
  const file = join(directory, 'chatgpt-plan-failures.json');
  if (kind === 'symlink') await symlink(outside, file); else await link(outside, file);
  const store = createPlanDiagnosticStore({ directory }); stores.push(store);
  logPlanFailure('responses', new Error('SECRET'));
  expect(await store.flush()).toBe(false);
  expect(await readFile(outside, 'utf8')).toBe('KEEP');
});
it('ends close within one second and never publishes a write that finishes after close timed out', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const actualOpen = fs.open;
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    const handle = await actualOpen(...args);
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async (...data) => { entered(); await waiting; return write(...data); };
    return handle;
  });
  const rename = vi.spyOn(fs, 'rename');
  const { store, directory, file } = await setup();
  logPlanFailure('responses', new DOMException('SECRET', 'TimeoutError')); await started;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const close = store.close(); await vi.advanceTimersByTimeAsync(1000);
  expect(await close).toBe(false);
  release(); vi.useRealTimers();
  await vi.waitFor(async () => {
    await expect(stat(join(directory, '.chatgpt-plan-failures.tmp'))).rejects.toHaveProperty('code', 'ENOENT');
  });
  expect(rename).not.toHaveBeenCalled();
  await expect(stat(file)).rejects.toHaveProperty('code', 'ENOENT');
});
it('expires disk records during the hourly sweep even without further errors', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  let clock = Date.parse('2026-10-22T00:00:00.000Z');
  const { store, file } = await setup({ directory: '', now: () => clock });
  logPlanFailure('responses', new DOMException('SECRET', 'TimeoutError')); await store.flush();
  clock += 25 * 60 * 60 * 1000;
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000); await store.flush();
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([]);
});
it('removes only its own exclusive leftover temporary file at startup', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const parent = await mkdtemp(join(tmpdir(), 'matrix-plan-diagnostics-')); directories.push(parent);
  const directory = join(parent, 'diagnostics'); await mkdir(directory, { mode: 0o700 });
  const temporary = join(directory, '.chatgpt-plan-failures.tmp'); await writeFile(temporary, 'crash leftover', { mode: 0o600 });
  const unrelated = join(directory, 'unrelated.log'); await writeFile(unrelated, 'KEEP');
  const store = createPlanDiagnosticStore({ directory }); stores.push(store);
  logPlanFailure('responses', new Error('SECRET')); expect(await store.flush()).toBe(true);
  await expect(stat(temporary)).rejects.toHaveProperty('code', 'ENOENT');
  expect(await readFile(unrelated, 'utf8')).toBe('KEEP');
});

it('actively rewrites sanitized historical records without preserving arbitrary historical fields', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const parent = await mkdtemp(join(tmpdir(), 'matrix-plan-diagnostics-')); directories.push(parent);
  const directory = join(parent, 'diagnostics'); await mkdir(directory, { mode: 0o700 });
  const file = join(directory, 'chatgpt-plan-failures.json');
  await writeFile(file, JSON.stringify([{ observedAt: '2026-10-22T00:00:00.000Z', stage: 'SECRET STAGE', category: 'SECRET CATEGORY', path: '/PRIVATE', token: 'SECRET TOKEN' }]), { mode: 0o600 });
  const store = createPlanDiagnosticStore({ directory, now: () => Date.parse('2026-10-22T00:00:00.000Z') }); stores.push(store);
  await vi.waitFor(async () => expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([{ observedAt: '2026-10-22T00:00:00.000Z', stage: 'other', category: 'local_failure' }]));
});
it('does not report flush complete while a coalesced successor write is still pending', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const actualRename = fs.rename;
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let renames = 0;
  vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
    if (++renames === 2) { entered(); await waiting; }
    return actualRename(...args);
  });
  vi.spyOn(fs, 'unlink').mockImplementationOnce(async () => {
    // A failure arrives as the first disk write settles, before the writer's
    // completion callback hands ownership to its coalesced successor.
    queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
      logPlanFailure('peer_poll', new DOMException('SECRET SECOND', 'TimeoutError'));
    })));
  });
  const { store, file } = await setup();
  logPlanFailure('peer_reply', new DOMException('SECRET FIRST', 'TimeoutError'));
  const flush = store.flush(); let settled = false; void flush.then(() => { settled = true; });
  await started; await Promise.resolve(); await Promise.resolve();
  const premature = settled; release(); await flush;
  expect(premature).toBe(false);
  expect(JSON.parse(await readFile(file, 'utf8')).map((row: {stage:string}) => row.stage)).toEqual(['peer_reply', 'peer_poll']);
});
it('cannot cancel an atomic rename already dispatched when bounded close expires', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const actualRename = fs.rename;
  let release!: () => void; let entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => { entered(); await waiting; return actualRename(...args); });
  const { store, file } = await setup();
  logPlanFailure('peer_reply', new DOMException('SECRET', 'TimeoutError')); await started;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const close = store.close(); await vi.advanceTimersByTimeAsync(1000);
  expect(await close).toBe(false);
  release(); vi.useRealTimers();
  await vi.waitFor(async () => expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(1));
});
it('cleans malformed JSON in its own fixed log file at startup without a new failure', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const parent = await mkdtemp(join(tmpdir(), 'matrix-plan-diagnostics-')); directories.push(parent);
  const directory = join(parent, 'diagnostics'); await mkdir(directory, { mode: 0o700 });
  const file = join(directory, 'chatgpt-plan-failures.json');
  await writeFile(file, '{ BROKEN SECRET HISTORY', { mode: 0o600 });
  const store = createPlanDiagnosticStore({ directory }); stores.push(store);
  await vi.waitFor(async () => expect(await readFile(file, 'utf8')).toBe('[]'), { timeout: 200 });
});


it('retries orphan temporary cleanup and the failed snapshot on the hourly sweep without a new failure or flush', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const actualRename = fs.rename, actualUnlink = fs.unlink;
  vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { code: 'EIO' }));
  const unlink = vi.spyOn(fs, 'unlink').mockRejectedValueOnce(Object.assign(new Error('Unavailable'), { code: 'EIO' }));
  const { store, directory, file } = await setup();
  logPlanFailure('responses', new DOMException('SECRET', 'TimeoutError'));
  expect(await store.flush()).toBe(false);
  const temporary = join(directory, '.chatgpt-plan-failures.tmp');
  expect((await stat(temporary)).isFile()).toBe(true);
  vi.mocked(fs.rename).mockImplementation(actualRename); unlink.mockImplementation(actualUnlink);
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  await vi.waitFor(async () => expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([
    expect.objectContaining({ stage: 'responses', category: 'timeout' }),
  ]));
  await expect(stat(temporary)).rejects.toHaveProperty('code', 'ENOENT');
});

it('does not sweep the temporary file owned by an active writer', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const actualOpen = fs.open;
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
    const handle = await actualOpen(...args), write = handle.writeFile.bind(handle);
    handle.writeFile = async (...data) => { entered(); await waiting; return write(...data); };
    return handle;
  });
  const unlink = vi.spyOn(fs, 'unlink');
  const { store, directory, file } = await setup();
  logPlanFailure('responses', new DOMException('SECRET', 'TimeoutError'));
  await started;
  try {
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(unlink).not.toHaveBeenCalled();
    expect((await stat(join(directory, '.chatgpt-plan-failures.tmp'))).isFile()).toBe(true);
  } finally { release(); }
  expect(await store.flush()).toBe(true);
  expect(JSON.parse(await readFile(file, 'utf8'))).toHaveLength(1);
});

it.each(['symlink', 'hardlink'] as const)('does not remove or follow a %s encountered by temporary maintenance', async kind => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const { store, directory } = await setup();
  expect(await store.flush()).toBe(true);
  const outside = join(directory, 'unrelated.log'); await writeFile(outside, 'KEEP');
  const temporary = join(directory, '.chatgpt-plan-failures.tmp');
  if (kind === 'symlink') await symlink(outside, temporary); else await link(outside, temporary);
  const unlink = vi.spyOn(fs, 'unlink');
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(unlink).not.toHaveBeenCalled();
  expect(await readFile(outside, 'utf8')).toBe('KEEP');
  expect((await fs.lstat(temporary)).isSymbolicLink()).toBe(kind === 'symlink');
});

it.each(['read', 'cleanup'] as const)('preserves saved history after a transient startup %s failure', async fault => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const parent = await mkdtemp(join(tmpdir(), 'matrix-plan-diagnostics-')); directories.push(parent);
  const directory = join(parent, 'diagnostics'); await mkdir(directory, { mode: 0o700 });
  const file = join(directory, 'chatgpt-plan-failures.json');
  const saved = { observedAt: new Date().toISOString(), stage: 'peer_poll', category: 'timeout' };
  await writeFile(file, JSON.stringify([saved]), { mode: 0o600 });
  const unavailable = Object.assign(new Error('Read unavailable'), { code: 'EIO' });
  if (fault === 'read') vi.spyOn(fs, 'open').mockRejectedValueOnce(unavailable);
  else {
    await writeFile(join(directory, '.chatgpt-plan-failures.tmp'), 'crash leftover', { mode: 0o600 });
    vi.spyOn(fs, 'unlink').mockRejectedValueOnce(unavailable);
  }
  const store = createPlanDiagnosticStore({ directory }); stores.push(store);
  await vi.waitFor(() => expect(warning).toHaveBeenCalled());
  logPlanFailure('peer_reply', new DOMException('SECRET', 'TimeoutError'));
  expect(await store.flush()).toBe(true);
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([
    saved, expect.objectContaining({ stage: 'peer_reply', category: 'timeout' }),
  ]);
});

it('does not replace unread saved history while startup reads keep failing', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const parent = await mkdtemp(join(tmpdir(), 'matrix-plan-diagnostics-')); directories.push(parent);
  const directory = join(parent, 'diagnostics'); await mkdir(directory, { mode: 0o700 });
  const file = join(directory, 'chatgpt-plan-failures.json');
  const saved = JSON.stringify([{ observedAt: new Date().toISOString(), stage: 'peer_poll', category: 'timeout' }]);
  await writeFile(file, saved, { mode: 0o600 });
  const actualOpen = fs.open;
  vi.spyOn(fs, 'open').mockImplementation((...args) => args[0] === file
    ? Promise.reject(Object.assign(new Error('Read unavailable'), { code: 'EIO' }))
    : actualOpen(...args));
  const store = createPlanDiagnosticStore({ directory }); stores.push(store);
  await vi.waitFor(() => expect(warning).toHaveBeenCalled());
  logPlanFailure('peer_reply', new DOMException('SECRET', 'TimeoutError'));
  expect(await store.flush()).toBe(false);
  expect(await readFile(file, 'utf8')).toBe(saved);
});
