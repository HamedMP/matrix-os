import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const cli = resolve('packages/sync-client/bin/matrix.mjs');
const origin = 'https://devstack.example.test';
let home: string;

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'matrix-devstack-stage3-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

function run(...args: string[]) {
  return exec(process.execPath, [cli, 'devstack', '--stage', '3', ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home, MATRIX_NO_TELEMETRY: '1' }, timeout: 20_000,
  });
}

describe('matrix devstack --stage 3', () => {
  it('returns a normal HTTPS chooser from a clean home', async () => {
    const { stdout } = await run('--platform', origin, '--json');
    expect(JSON.parse(stdout)).toEqual({ v: 1, ok: true, data: { entryUrl: `${origin}/devstack` } });
  });

  it('opens the configured DevStack origin without inheriting the Main profile', async () => {
    const configDir = join(home, '.matrixos');
    await mkdir(configDir, { mode: 0o700 });
    await writeFile(join(configDir, 'profiles.json'), JSON.stringify({
      active: 'main',
      profiles: {
        main: { platformUrl: 'https://main.example.test', gatewayUrl: 'https://main.example.test' },
        devstack: { platformUrl: origin, gatewayUrl: origin },
      },
    }));
    const legacyAuth = join(configDir, 'auth.json');
    await writeFile(legacyAuth, 'legacy-auth-sentinel', { mode: 0o600 });
    const { stdout } = await run('--json');
    expect(JSON.parse(stdout).data).toEqual({ entryUrl: `${origin}/devstack` });
    expect(await readFile(legacyAuth, 'utf8')).toBe('legacy-auth-sentinel');
  });

  it('links to an explicit registered Computer and worktree without passing local paths', async () => {
    const { stdout } = await run('--platform', origin, '--computer', 'dev-one', '--worktree', 'feature-one', '--json');
    expect(JSON.parse(stdout).data).toEqual({
      computer: 'dev-one', worktree: 'feature-one', entryUrl: `${origin}/devstack/dev-one/feature-one`,
    });
    await expect(run('--platform', origin, '--worktree', '/tmp/worktree', '--json')).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('devstack_selection_required'),
    });
  });

  it.each(['http://devstack.example.test', 'https://user:pass@devstack.example.test', 'https://devstack.example.test/path'])(
    'rejects an unsafe browser origin %s', async platform => {
      await expect(run('--platform', platform, '--json')).rejects.toMatchObject({
        code: 1, stderr: expect.stringContaining('devstack_invalid_origin'),
      });
    },
  );

  it('rejects unsupported Stage 3 writer operations before touching the checkout', async () => {
    await expect(run('sync', '--platform', origin, '--json')).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('devstack_action_unsupported'),
    });
  });
});
