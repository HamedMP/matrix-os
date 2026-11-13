import { execFileSync, spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyToken } from '@clerk/backend';
import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { createShellCommandRunner } from '../../packages/gateway/src/shell/command-runner.js';
import { createClerkAuth, type ClerkAuth, type ClerkTokenPayload } from '../../packages/platform/src/clerk-auth.js';
import { loadDevstackRunConfig } from '../../packages/platform/src/devstack-runs/config.js';
import { createDevstackRunRoutes } from '../../packages/platform/src/devstack-runs/routes.js';
import { executeDevstackRun } from '../../packages/platform/src/devstack-runs/execute.js';
import type { DevstackRunStore } from '../../packages/platform/src/devstack-runs/store.js';
import { ClerkOrganizationUpstreamClient } from '../../packages/platform/src/organizations/clerk-resolver.js';

const owner = 'user_devstack_owner';
const peer = 'user_devstack_peer';
const issuer = 'https://clerk.example.test';
const internalOrganizationId = 'org_PrivatePreview';
const target = {
  runtime: 'dev-runtime', worktree: 'feature-a', owner, handle: 'devstack-fixture',
  containerId: 'a'.repeat(64), cwd: 'projects/feature-a', revision: 'b'.repeat(40),
};
const input = { issuer, previewOrigin: 'https://preview.example.test', operators: [owner, peer], targets: [target] };
const runId = 'fed826e0-6c0f-4a5d-8ce2-55cbc2866c1a';
const key = 'c'.repeat(64);
const command = { runId, runtime: target.runtime, worktree: target.worktree, kind: 'test', command: ['bun', 'run', 'test'] };

function config() {
  return loadDevstackRunConfig(JSON.stringify(input), 'stage-two')!;
}

function setup(clerk?: ClerkAuth, isMember = vi.fn<(actorId: string) => Promise<boolean>>().mockResolvedValue(true)) {
  const payload = {
    sub: owner, sid: 'sess_fixture', exp: Math.floor(Date.now() / 1000) + 600, iss: issuer,
  };
  const defaultClerk = createClerkAuth({
    verifyToken: async token => {
      if (token === 'sync-token') throw new Error('Invalid Clerk signature');
      return {
        ...payload, ...(token === 'unlisted' ? { sub: 'user_unlisted' } : {}),
        ...(token === 'wrong-issuer' ? { iss: 'https://foreign.example.test' } : {}),
        ...(token === 'impersonated' ? { act: { sub: 'user_actor' } } : {}),
        ...(token === 'pending' ? { sts: 'pending' } : {}),
        ...(token === 'expired' ? { exp: 1 } : {}),
      };
    },
  });
  const store = {
    read: vi.fn<DevstackRunStore['read']>().mockResolvedValue(undefined),
    admit: vi.fn<DevstackRunStore['admit']>(),
    finish: vi.fn<DevstackRunStore['finish']>().mockResolvedValue(undefined),
  };
  const resolve = vi.fn().mockResolvedValue({
    handle: target.handle, clerkUserId: owner, containerId: target.containerId, host: 'matrixos-devstack-fixture', port: 4000,
  });
  const execute = vi.fn().mockResolvedValue({ status: 'succeeded', exitCode: 0, logs: [], truncated: false });
  const app = createDevstackRunRoutes({ config: config(), clerkAuth: clerk ?? defaultClerk, isMember, store, resolve, execute });
  function dispatch(token = 'allowed', body: object = command, runKey = key) {
    return app.request('/', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token, 'x-devstack-run-key': runKey },
      body: JSON.stringify(body),
    });
  }
  return { app, store, resolve, execute, dispatch, isMember };
}

describe('recoverable DevStack run config', () => {
  it('refuses unrelated mode, unsafe paths, duplicate runtime bindings and a fourth operator', () => {
    expect(loadDevstackRunConfig(undefined, undefined)).toBeUndefined();
    expect(() => loadDevstackRunConfig(JSON.stringify(input), undefined)).toThrow(/DevStack/);
    for (const bad of [
      { ...input, operators: [owner, peer, 'user_3', 'user_4'] },
      { ...input, operators: [owner, owner] },
      { ...input, previewOrigin: 'https://preview.example.test/elsewhere' },
      { ...input, targets: [{ ...target, cwd: 'projects/../foreign' }] },
      { ...input, targets: [target, { ...target, worktree: 'duplicate' }] },
    ]) {
      expect(() => loadDevstackRunConfig(JSON.stringify(bad), 'stage-two')).toThrow(/DevStack/);
    }
  });
});

describe('recoverable DevStack run HTTP boundary', () => {
  it('uses the verified Clerk subject to check the existing internal organization without a custom claim', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwtKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const clerk = createClerkAuth({ verifyToken: async token => await verifyToken(token, { jwtKey }) as ClerkTokenPayload });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      data: [{ id: 'orgmem_fixture', organization: { id: internalOrganizationId } }], total_count: 1,
    }));
    const upstream = new ClerkOrganizationUpstreamClient({ secretKey: 'fixture', fetchImpl });
    const isMember = vi.fn(async (actorId: string) => (await upstream.listOrganizationsForActor(actorId)).includes(internalOrganizationId));
    const { app, store } = setup(clerk, isMember);
    const signed = (subject: string) => new SignJWT({ sid: 'sess_fixture' })
      .setProtectedHeader({ alg: 'RS256', kid: 'devstack-test' }).setIssuer(issuer).setSubject(subject)
      .setIssuedAt().setExpirationTime('1m').sign(privateKey);
    const result = (token: string) => app.request('/' + runId, {
      headers: { authorization: 'Bearer ' + token, 'x-devstack-run-key': key },
    });
    const unlisted = await signed('user_unlisted');
    const [header, payload, signature] = unlisted.split('.');
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    claims.sub = owner;
    const forged = [header, Buffer.from(JSON.stringify(claims)).toString('base64url'), signature].join('.');
    expect((await result(forged)).status).toBe(401);
    expect((await result(unlisted)).status).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.read).not.toHaveBeenCalled();

    expect((await result(await signed(owner))).status).toBe(404);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.clerk.com/v1/users/user_devstack_owner/organization_memberships?limit=100&offset=0',
      expect.objectContaining({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal) }),
    );
    expect(store.read).toHaveBeenCalledTimes(1);
  });

  it('checks the signed subject, issuer, live session and recovery key before requesting membership', async () => {
    const { dispatch, store, app, isMember } = setup();
    for (const token of ['unlisted', 'wrong-issuer', 'impersonated', 'pending', 'expired']) {
      expect((await dispatch(token)).status).toBe(403);
    }
    expect((await dispatch('sync-token')).status).toBe(401);
    expect((await dispatch('allowed', command, 'bad-key')).status).toBe(404);
    expect((await app.request('/' + runId, { headers: { cookie: '__session=allowed', 'x-devstack-run-key': key } })).status).toBe(401);
    expect(isMember).not.toHaveBeenCalled();
    expect(store.read).not.toHaveBeenCalled();
    expect(store.admit).not.toHaveBeenCalled();
  });

  it('fails closed if the allowlisted subject loses membership or membership lookup is unavailable', async () => {
    const { app, dispatch, isMember, store } = setup();
    isMember.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('private upstream failure'));
    expect((await dispatch()).status).toBe(403);
    const failure = await app.request('/' + runId, {
      headers: { authorization: 'Bearer allowed', 'x-devstack-run-key': key },
    });
    expect(failure.status).toBe(503);
    expect(await failure.json()).toEqual({ error: 'DevStack run service unavailable' });
    expect(isMember.mock.calls).toEqual([[owner], [owner]]);
    expect(store.read).not.toHaveBeenCalled();
    expect(store.admit).not.toHaveBeenCalled();
  });

  it('rejects client-controlled paths and stopped or replaced registrations before admission', async () => {
    const { dispatch, store, resolve } = setup();
    expect((await dispatch('allowed', { ...command, cwd: 'projects/other' })).status).toBe(400);
    expect((await dispatch('allowed', { ...command, worktree: 'unknown' })).status).toBe(404);
    resolve.mockResolvedValueOnce({ containerId: '0'.repeat(64) });
    expect((await dispatch()).status).toBe(409);
    expect(store.admit).not.toHaveBeenCalled();
  });

  it('returns a run ID before completion and replays the original admission without starting twice', async () => {
    const { dispatch, app, store, execute } = setup();
    let finish!: (value: Awaited<ReturnType<typeof executeDevstackRun>>) => void;
    execute.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    store.admit.mockImplementation(async record => ({ outcome: 'admitted', record: { ...record, status: 'running', exitCode: null, logs: [], truncated: false } }));
    const first = await dispatch();
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({
      runId, status: 'running', worktree: target.worktree, revision: target.revision,
      previewUrl: 'https://preview.example.test/vm/devstack-fixture/', exitCode: null, logs: [], nextCursor: 0,
    });
    const row = store.admit.mock.calls[0][0];
    expect(row.keyDigest).not.toBe(key);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    finish({ status: 'succeeded', exitCode: 0, logs: [{ stream: 'stdout', text: 'passed' }], truncated: false });
    await vi.waitFor(() => expect(store.finish).toHaveBeenCalledTimes(1));
    store.read.mockResolvedValue({ ...row, status: 'succeeded', exitCode: 0, logs: [{ stream: 'stdout', text: 'passed' }] });
    const again = await dispatch();
    expect(again.status).toBe(202);
    expect(execute).toHaveBeenCalledTimes(1);
    const result = await app.request('/' + runId + '?cursor=0', { headers: {
      authorization: 'Bearer allowed', 'x-devstack-run-key': key,
    } });
    expect(await result.json()).toMatchObject({
      status: 'succeeded', testResult: { status: 'passed', exitCode: 0 },
      logs: [{ stream: 'stdout', text: 'passed' }], nextCursor: 1,
    });
  });
});

describe('Gateway executor', () => {
  it.skipIf(process.platform === 'win32').each([
    { mode: 'normal', timeoutMs: 2_000, expectedStatus: 'succeeded', expectedExit: 0 },
    { mode: 'timeout', timeoutMs: 500, expectedStatus: 'timed_out', expectedExit: null },
  ])('stops a same-group descendant after $mode leader exit', async ({ mode, timeoutMs, expectedStatus, expectedExit }) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'devstack-run-descendants-')));
    const marker = join(root, 'descendant-survived');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const commandRunner = createShellCommandRunner({ homePath: root });
    try {
      git('init', '-q');
      git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false',
        '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'pinned revision');
      const pinned = { ...target, revision: git('rev-parse', 'HEAD').trim() };
      const leader = `
        const child = require('node:child_process').spawn(process.execPath, [
          '-e', 'setTimeout(() => require("node:fs").writeFileSync(process.argv[1], "alive"), 800)', process.argv[1],
        ], { stdio: 'ignore' });
        child.once('spawn', () => {
          console.log('spawned descendant');
          console.error('leader stderr');
          child.unref();
          if (process.argv[2] === 'timeout') setInterval(() => {}, 1000);
        });
      `;
      const result = await executeDevstackRun({
        endpoint: { source: 'record', handle: target.handle, clerkUserId: owner, containerId: target.containerId,
          host: 'matrixos-devstack-fixture', port: 4000, shellPort: 3000, status: 'running' },
        instance: 'stage-two', target: pinned, command: [process.execPath, '-e', leader, '--', marker, mode],
        platformSecret: 'fixture-private-secret',
        fetch: async (_url, init) => {
          const { command: argv } = JSON.parse(String(init?.body));
          argv[0] = process.execPath;
          argv[4] = root;
          return Response.json(await commandRunner.run({ command: argv, timeoutMs }));
        },
      });
      expect(result).toMatchObject({
        status: expectedStatus, exitCode: expectedExit,
        logs: [{ stream: 'stdout', text: 'spawned descendant\n' }, { stream: 'stderr', text: 'leader stderr\n' }],
      });
      await delay(1_000);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('executes the actual Node wrapper only at the pinned Git root and revision', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'devstack-run-worktree-'));
    const root = realpathSync(temp);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const commit = (message: string) => git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', message);
    try {
      git('init', '-q');
      commit('pinned revision');
      const pinned = { ...target, revision: git('rev-parse', 'HEAD').trim() };
      const fetchImpl: typeof fetch = async (_url, init) => {
        const { command: [, ...argv] } = JSON.parse(String(init?.body));
        argv[3] = root; // Substitute the test-owned directory for the native host's canonical path.
        const result = spawnSync(process.execPath, argv, { cwd: root, encoding: 'utf8', timeout: 5000 });
        if (result.error) throw result.error;
        return Response.json({
          exitCode: result.status, signal: result.signal, timedOut: false, truncated: false,
          stdout: result.stdout, stderr: result.stderr,
        });
      };
      const run = () => executeDevstackRun({
        endpoint: { source: 'record', handle: target.handle, clerkUserId: owner, containerId: target.containerId,
          host: 'matrixos-devstack-fixture', port: 4000, shellPort: 3000, status: 'running' },
        instance: 'stage-two', target: pinned, command: [process.execPath, '-e', 'console.log(process.cwd())'],
        platformSecret: 'fixture-private-secret', fetch: fetchImpl,
      });
      expect(await run()).toMatchObject({ status: 'succeeded', exitCode: 0, logs: [{ stream: 'stdout', text: root + '\n' }] });
      commit('moved revision');
      expect(await run()).toMatchObject({ status: 'binding_rejected', exitCode: null, logs: [] });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });


  it('uses the registered alias, drops the binding marker and detects a rejected binding', async () => {
    const endpoint = {
      source: 'record', handle: target.handle, clerkUserId: owner, containerId: target.containerId,
      host: 'matrixos-devstack-fixture', port: 4000, shellPort: 3000, status: 'running',
    } as const;
    const request = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(String(url)).toBe('http://matrixos-devstack-fixture:4000/api/terminal/run');
      expect(init).toMatchObject({ redirect: 'error', method: 'POST', signal: expect.any(AbortSignal) });
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ cwd: target.cwd, timeoutMs: 120000 });
      expect(body.command.slice(-3)).toEqual(command.command);
      expect(body.command).toContain('/var/lib/matrix-devstack/stage-two/home/projects/feature-a');
      expect(body.command).toContain(target.revision);
      const marker = body.command[6];
      return Response.json({ exitCode: 0, signal: null, timedOut: false, truncated: false, stdout: marker + '\npass', stderr: '' });
    });
    const run = () => executeDevstackRun({ endpoint, instance: 'stage-two', target, command: command.command,
      platformSecret: 'fixture-private-secret', fetch: request });
    expect(await run()).toMatchObject({ status: 'succeeded', exitCode: 0, logs: [{ stream: 'stdout', text: 'pass' }] });
    request.mockResolvedValueOnce(Response.json({
      exitCode: 125, signal: null, timedOut: false, truncated: false, stdout: '', stderr: 'private path',
    }));
    expect(await run()).toMatchObject({ status: 'binding_rejected', exitCode: null, logs: [] });
  });
});
