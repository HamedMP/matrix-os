import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { EventEmitter, once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forwardDevstackWatchSignals } from '../../packages/sync-client/src/lib/devstack-watch-signals.mjs';

const exec = promisify(execFile);
const cli = resolve('packages/sync-client/bin/matrix.mjs');
const computer = 'hel1-stage3';
const worktree = 'eng432-hel1-pilot';
const args = [cli, 'devstack', 'watch', '--stage', '3', '--computer', computer, '--worktree', worktree, '--json'];
const first = 'a'.repeat(64);
const second = 'b'.repeat(64);
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'matrix-devstack-watch-'));
  await mkdir(join(home, '.matrixos'), { mode: 0o700 });
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function env() {
  return { ...process.env, HOME: home, USERPROFILE: home, MATRIX_NO_TELEMETRY: '1' };
}

async function installAdapter(program: string, mode = 0o700) {
  await writeFile(join(home, '.matrixos', 'devstack-stage3-adapter'), `#!${process.execPath}
if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify(['watch', computer, worktree]))}) process.exit(64);
const emit = record => console.log(JSON.stringify(record));
${program}
`, { mode });
}

function run() {
  return exec(process.execPath, args, { env: env(), timeout: 55_000 });
}

function data(stdout: string) {
  return stdout.trim().split('\n').map(line => JSON.parse(line).data);
}

describe('matrix devstack watch', () => {
  it.each([
    { argv: ['devstack', 'connect', '--worktree', 'watch'] },
    { argv: ['run', '--', 'devstack', 'watch'] },
    { argv: ['--profile', 'devstack', 'shell', 'attach', 'watch'] },
  ])('leaves signal handling unchanged for unrelated arguments $argv', ({ argv }) => {
    const child = new EventEmitter();
    const before = process.listenerCount('SIGTERM');
    try {
      forwardDevstackWatchSignals(child, argv);
      expect(process.listenerCount('SIGTERM')).toBe(before);
    } finally {
      child.emit('exit');
    }
  });

  it('recognizes watch with flags before the command and action', () => {
    const child = new EventEmitter();
    const before = process.listenerCount('SIGTERM');
    try {
      forwardDevstackWatchSignals(child, ['--json', 'devstack', '--stage', '3', 'watch']);
      expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    } finally {
      child.emit('exit');
    }
  });

  it('streams distinct content revisions and their test receipts', async () => {
    await installAdapter(`
emit({type:'ready'});
emit({type:'update',revision:'${first}'});
emit({type:'test',revision:'${first}',exitCode:1,log:'1 failed, 3 passed'});
emit({type:'update',revision:'${second}'});
emit({type:'test',revision:'${second}',exitCode:0,log:'4 passed'});
emit({type:'stopped'});
`);
    const { stdout } = await run();
    expect(data(stdout)).toEqual([
      { type: 'ready', computer, worktree },
      { type: 'update', computer, worktree, revision: first },
      { type: 'test', computer, worktree, revision: first, exitCode: 1, log: '1 failed, 3 passed' },
      { type: 'update', computer, worktree, revision: second },
      { type: 'test', computer, worktree, revision: second, exitCode: 0, log: '4 passed' },
      { type: 'stopped', computer, worktree },
    ]);
  });

  it('requires the private installed adapter', async () => {
    await installAdapter('throw Error("private diagnostic")', 0o755);
    await expect(run()).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('devstack_adapter_unavailable'),
    });
  });

  it.each([
    ['orphan test', `emit({type:'ready'}); emit({type:'test',revision:'${first}',exitCode:0,log:'orphan'});`],
    ['mismatched revision', `emit({type:'ready'}); emit({type:'update',revision:'${first}'}); emit({type:'test',revision:'${second}',exitCode:0,log:'mismatched'});`],
    ['unknown field', `emit({type:'ready'}); emit({type:'update',revision:'${first}',token:'private-marker'});`],
    ['oversized line', `emit({type:'ready'}); console.log('x'.repeat(32768));`],
    ['missing stopped', `emit({type:'ready'});`],
  ])('fails closed on %s', async (_label, program) => {
    await installAdapter(program + '\nconsole.error("private-marker");');
    const result = run();
    await expect(result).rejects.toMatchObject({
      code: 1,
      stdout: expect.not.stringContaining('private-marker'),
      stderr: expect.stringContaining('devstack_watch_failed'),
    });
    await expect(result).rejects.not.toMatchObject({ stderr: expect.stringContaining('private-marker') });
  }, 60_000);

  it('forwards termination of the published command and waits for rollback', async () => {
    await installAdapter(`
process.on('SIGTERM', () => { clearTimeout(deadline); emit({type:'stopped'}); });
const deadline = setTimeout(() => { process.exitCode = 9; }, 5000);
emit({type:'ready'});
`);
    const child = spawn(process.execPath, args, { env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    let stdout = '';
    let signalled = false;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (!signalled && stdout.includes('"type":"ready"')) {
        signalled = true;
        child.kill('SIGTERM');
      }
    });
    expect(await closed).toEqual([0, null]);
    expect(data(stdout).map(receipt => receipt.type)).toEqual(['ready', 'stopped']);
  }, 60_000);
});
