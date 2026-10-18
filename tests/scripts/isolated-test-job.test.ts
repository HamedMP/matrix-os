import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { isolatedTestJob, waitForTestJob } from '../../scripts/dev/isolated-test-job.mjs';

const host = { platform: 'linux', uid: 999, gid: 1000, totalMemory: 16 * 1024 ** 3, cpus: 8,
  home: '/home/matrix', cwd: '/work/tree', unitId: 'a'.repeat(24) };

describe('bounded Matrix test jobs', () => {
  it('runs the unfiltered canonical suite with one worker inside the shared memory budget', async () => {
    const pkg = JSON.parse(await readFile('package.json','utf8'));
    expect(pkg.scripts['test:isolated']).toBe('node scripts/dev/isolated-test-job.mjs -- bun run test -- --maxWorkers=1');
  });
  it('keeps stopping a canceled launch until a late-created service closes', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter(), signals = new EventEmitter();
    let unitReady = false;
    const stop = vi.fn(() => { if (unitReady) child.emit('close', 0, null); });
    try {
      const done = waitForTestJob(child, stop, signals);
      signals.emit('SIGTERM'); expect(stop).toHaveBeenCalledOnce();
      unitReady = true; await vi.advanceTimersByTimeAsync(250);
      await expect(done).resolves.toBe(143);
      expect(stop.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(signals.listenerCount('SIGTERM')).toBe(0); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('drains cancellation once more if the starter closes during a stop attempt', async () => {
    const child = new EventEmitter(), signals = new EventEmitter(), stop = vi.fn();
    const done = waitForTestJob(child, stop, signals);
    signals.emit('SIGINT'); child.emit('close', 1, null);
    await expect(done).resolves.toBe(130); expect(stop).toHaveBeenLastCalledWith(true);
    expect(signals.listenerCount('SIGINT')).toBe(0);
  });
  it('uses a system service with the caller identity and a shared worktree admission lock', () => {
    const job = isolatedTestJob(host, ['bun', 'run', 'test'], { PATH: '/tools/bin:/usr/bin', MATRIX_TEST_WORKERS: '2' });
    expect(job.unit).toBe(`matrix-test-999-${host.unitId}.service`);
    expect(job.args).toEqual(expect.arrayContaining(['--uid=999', '--gid=1000', '--wait', '--pipe', '--collect',
      '--property=MemoryMax=6144M', '--property=MemorySwapMax=0', '--property=CPUQuota=400%',
      '--property=MemoryHigh=6144M', '--property=TemporaryFileSystem=/run/user:ro',
      '--property=KillMode=control-group', '--property=RuntimeMaxSec=10800', '--expand-environment=no']));
    expect(job.args).not.toContain('--user'); expect(job.args).not.toContain('--scope');
    expect(job.args.slice(-7)).toEqual(['/usr/bin/flock', '--no-fork', '--timeout=7200', '/home/matrix/.cache/matrix-test-jobs/admission.lock', 'bun', 'run', 'test']);
    expect(job.preserve).toContain('MATRIX_TEST_WORKERS');
  });
  it('keeps the caller tool path even when sudo replaces PATH', () => {
    const job = isolatedTestJob(host, ['bun','run','test'], { PATH:'/owner/flox/bin:/usr/bin' });
    expect(job.args).toContain('--setenv=PATH=/owner/flox/bin:/usr/bin');
    expect(job.args).not.toContain('--setenv=PATH');
  });
  it('forwards exact commands and native fixture selection without putting secrets in argv', () => {
    const command = ['node', 'test.mjs', '$HOME', 'a b', '$(touch /tmp/no)'];
    const job = isolatedTestJob(host, command, { MATRIX_PLATFORM_FIXTURE_POSTGRES_URL: 'postgres://synthetic-secret', PLATFORM_SECRET: 'private' });
    expect(job.args.slice(-command.length)).toEqual(command);
    expect(job.preserve).toContain('MATRIX_PLATFORM_FIXTURE_POSTGRES_URL');
    expect(job.preserve).not.toContain('PLATFORM_SECRET');
    expect(job.args.join(' ')).not.toContain('synthetic-secret');
  });
  it.each([{...host, platform:'darwin'}, {...host, uid:0}, {...host, unitId:'../gateway'}, {...host, totalMemory:1024**3}])('fails closed for unsupported ownership or capacity', input => {
    expect(() => isolatedTestJob(input, ['bun','run','test'], {})).toThrow();
  });
  it('reserves machine capacity rather than assigning all RAM or CPUs', () => {
    const job = isolatedTestJob({...host,totalMemory:8*1024**3,cpus:2}, ['bun','run','test'], {});
    expect(job.memoryMiB).toBeLessThan(4*1024);expect(job.args).toContain('--property=CPUQuota=100%');
    expect(job.args).toContain(`--property=MemoryHigh=${job.memoryMiB}M`);
  });
  it.each([[], [''], ['x'.repeat(4097)]])('rejects malformed commands', command => {
    expect(() => isolatedTestJob(host, command, {})).toThrow();
  });
});
