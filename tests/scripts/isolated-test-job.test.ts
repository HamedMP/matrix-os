import { describe, expect, it } from 'vitest';
import { isolatedTestJob } from '../../scripts/dev/isolated-test-job.mjs';

const host = { platform: 'linux', uid: 999, gid: 1000, totalMemory: 16 * 1024 ** 3, cpus: 8,
  home: '/home/matrix', cwd: '/work/tree', unitId: 'a'.repeat(24) };

describe('bounded Matrix test jobs', () => {
  it('uses a system service with the caller identity and a shared worktree admission lock', () => {
    const job = isolatedTestJob(host, ['bun', 'run', 'test'], { PATH: '/tools/bin:/usr/bin', MATRIX_TEST_WORKERS: '2' });
    expect(job.unit).toBe(`matrix-test-999-${host.unitId}.service`);
    expect(job.args).toEqual(expect.arrayContaining(['--uid=999', '--gid=1000', '--wait', '--pipe', '--collect',
      '--property=MemoryMax=6144M', '--property=MemorySwapMax=0', '--property=CPUQuota=400%',
      '--property=KillMode=control-group', '--property=RuntimeMaxSec=10800', '--expand-environment=no']));
    expect(job.args).not.toContain('--user'); expect(job.args).not.toContain('--scope');
    expect(job.args.slice(-7)).toEqual(['/usr/bin/flock', '--no-fork', '--timeout=7200', '/home/matrix/.cache/matrix-test-jobs/admission.lock', 'bun', 'run', 'test']);
    expect(job.preserve).toContain('MATRIX_TEST_WORKERS');
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
  });
  it.each([[], [''], ['x'.repeat(4097)]])('rejects malformed commands', command => {
    expect(() => isolatedTestJob(host, command, {})).toThrow();
  });
});
