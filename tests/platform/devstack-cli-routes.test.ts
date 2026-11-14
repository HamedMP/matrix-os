import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createStage3DeltaStage } from '../../scripts/devstack/stage3-delta-stage.mjs';
import { createStage3SourceSync, identifyStage3Source, identifyStage3Target } from '../../scripts/devstack/stage3-source.mjs';
import { Hono } from 'hono';
import { createDevstackPublicPreviewAccess } from '../../packages/platform/src/devstack-public-preview.js';
import { describe, expect, it, vi } from 'vitest';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { createDevstackCliRoutes, type DevstackSourceReceipt } from '../../packages/platform/src/devstack-cli-routes.js';
import type { DevstackCliBinding } from '../../packages/platform/src/devstack-cli-pairing.js';
import type { DevstackSourceDelta } from '../../packages/platform/src/devstack-source-delta.js';
import { loadDevstackPreviewConfig } from '../../packages/platform/src/devstack-runs/config.js';
import { desktopPalette } from '@matrix-os/brand/tokens';

const origin = 'https://devstack.example.test';
const issuer = 'https://clerk.example.test';
const owner = 'user_owner';
const other = 'user_other';
const target = { runtime: 'runtime-one', worktree: 'worktree-one', owner, handle: 'dev-one', containerId: 'a'.repeat(64) };
const peer = { runtime: 'runtime-two', worktree: 'worktree-two', owner: other, handle: 'dev-two', containerId: 'b'.repeat(64) };
const sourceIdentity = 'c'.repeat(64);
const pair = '/devstack/cli/pair';
const poll = '/devstack/cli/poll';

type ApplySource = (binding: DevstackCliBinding, delta: DevstackSourceDelta,
  assertCurrent: () => Promise<void>) => Promise<DevstackSourceReceipt>;
const exec = promisify(execFile);
function fixture(runSource?: ApplySource) {
  const config = loadDevstackPreviewConfig(JSON.stringify({
    issuer, previewOrigin: origin, operators: [owner, other], targets: [target, peer],
    publicBrowserOnly: true,
  }), 'stage-three')!;
  const clerkAuth = createClerkAuth({
    async verifyToken(token) {
      if (token !== owner && token !== other) throw new Error('Invalid fixture');
      return { sub: token, sid: 'sess_fixture', exp: Math.floor(Date.now() / 1000) + 60, iss: issuer };
    },
  });
  const isMember = vi.fn(async (_id: string) => true);
  const resolve = vi.fn(async (entry: typeof target) => ({
    handle: entry.handle, clerkUserId: entry.owner, containerId: entry.containerId,
  }));
  const applySource = vi.fn<ApplySource>(runSource ?? (async (_binding, _delta, assertCurrent) => {
    await assertCurrent();
    return { revision: 'e'.repeat(64), files: 1, updated: 1, removed: 0,
      test: { revision: 'e'.repeat(64), exitCode: 0, log: '4 tests passed' } };
  }));
  const deps = { config, clerkAuth, isMember, resolve, publishableKey: 'pk_test_fixture' };
  const app = new Hono();
  app.use('*', createDevstackPublicPreviewAccess({
    ...deps, cliPairingEnabled: true, cliSourceEnabled: true, resolve: async entry => ({
      ...await resolve(entry), source: 'record', host: 'loopback', port: 4000, shellPort: 3000, status: 'running',
    }),
  }).middleware);
  app.route('/', createDevstackCliRoutes({ ...deps, enabledWorktrees: new Set([target.worktree]), source: { identity: sourceIdentity, apply: applySource } }));
  const request = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (!headers.has('host')) headers.set('host', new URL(origin).hostname);
    return app.request(origin + path, { ...init, headers });
  };
  const post = (path: string, data: unknown, headers?: Record<string, string>) => request(path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data),
  });
  const approve = (approvalId: string, worktree = target.worktree, user = owner, requestOrigin = origin) =>
    request(pair + '/' + approvalId, { method: 'POST', headers: { origin: requestOrigin, cookie: '__session=' + user },
      body: new URLSearchParams({ worktree }) });
  return { request, post, approve, isMember, resolve, applySource };
}

describe('hosted DevStack CLI pairing routes', () => {
  it('uses normal Clerk sign-in and explicit worktree approval, then returns a single scoped grant', async () => {
    const { request, post, approve } = fixture();
    const response = await post(pair, { sourceIdentity });
    expect(response.status).toBe(201);
    const { approvalId, pollSecret } = await response.json();
    const path = pair + '/' + approvalId;
    const signIn = await request(path);
    expect(signIn.status).toBe(200);
    expect(await signIn.text()).toContain('var redirectTarget = "' + path + '"');
    expect((await post(poll, { pollSecret })).status).toBe(202);

    const approval = await request(path, { headers: { cookie: '__session=' + owner } });
    expect(approval.status).toBe(200);
    const html = await approval.text();
    expect(html).toContain(target.worktree);
    expect(html).toContain(sourceIdentity.slice(0, 12));
    expect(html).not.toContain(peer.worktree);
    expect(html).not.toContain(pollSecret);
    expect(html).toContain(`background: ${desktopPalette.paper}`);
    expect(html).toContain(`background: ${desktopPalette.forest}`);
    expect(html).toContain('button:focus-visible');
    expect(html).toContain('overflow-wrap: anywhere');
    const styleNonce = /<style nonce="([^"]+)">/.exec(html)?.[1];
    expect(styleNonce).toBeTruthy();
    expect(approval.headers.get('content-security-policy')).toContain(`style-src 'nonce-${styleNonce}'`);
    expect((await approve(approvalId)).headers.get('location')).toBe('/devstack/worktrees/worktree-one/');
    const grant = await post(poll, { pollSecret });
    expect(grant.status).toBe(200);
    expect(grant.headers.get('cache-control')).toBe('private, no-store');
    expect(await grant.json()).toEqual({ bearer: expect.any(String), expiresAt: expect.any(Number),
      binding: { runtime: target.runtime, worktree: target.worktree, sourceIdentity, sourceSync: true } });
    expect((await post(poll, { pollSecret })).status).toBe(404);
  });

  it('checks membership, same origin, the owner, and the live target', async () => {
    const { post, approve, resolve, isMember } = fixture();
    const { approvalId, pollSecret } = await (await post(pair, { sourceIdentity })).json();
    expect((await approve(approvalId, target.worktree, owner, 'https://untrusted.test')).status).toBe(403);
    expect((await approve(approvalId, target.worktree, other)).status).toBe(404);
    expect((await approve(approvalId, peer.worktree)).status).toBe(404);
    isMember.mockResolvedValueOnce(false);
    expect((await approve(approvalId)).status).toBe(403);
    resolve.mockResolvedValueOnce({ ...target, clerkUserId: owner, containerId: 'd'.repeat(64) });
    expect((await approve(approvalId)).status).toBe(404);
    expect((await post(poll, { pollSecret })).status).toBe(202);
  });

  it('applies a source delta only for the current approval and returns the matching test receipt', async () => {
    const { post, approve, applySource, resolve } = fixture();
    const source = '/devstack/cli/source';
    const delta = { base: 'a'.repeat(40), entries: [{ path: 'shell/example.ts', kind: 'file', mode: 420, content: 'YQ==' }] };
    const { approvalId, pollSecret } = await (await post(pair, { sourceIdentity })).json();
    expect((await approve(approvalId)).status).toBe(303);
    const { bearer } = await (await post(poll, { pollSecret })).json();
    expect((await post(source, delta)).status).toBe(401);
    expect((await post(source, { ...delta, worktree: peer.worktree }, { authorization: 'Bearer ' + bearer })).status).toBe(400);
    expect(applySource).not.toHaveBeenCalled();

    const response = await post(source, delta, { authorization: 'Bearer ' + bearer });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revision: 'e'.repeat(64), test: { revision: 'e'.repeat(64), exitCode: 0 } });
    expect(applySource).toHaveBeenCalledWith(expect.objectContaining({
      sourceIdentity, owner, worktree: target.worktree, containerId: target.containerId,
    }), delta, expect.any(Function));
    resolve.mockResolvedValueOnce({ handle: target.handle, clerkUserId: owner, containerId: 'f'.repeat(64) });
    expect((await post(source, delta, { authorization: 'Bearer ' + bearer })).status).toBe(409);
    expect(applySource).toHaveBeenCalledTimes(1);
  });

  it('publishes two exact Git deltas through the public guard into an isolated mirror and rolls back', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'devstack-cli-route-source-')));
    try {
      const staging = join(root, 'staging');
      const mirror = join(root, 'mirror');
      await Promise.all([mkdir(staging, { mode: 0o700 }), mkdir(mirror, { mode: 0o700 })]);
      const git = (...args: string[]) => exec('git', ['-C', staging, ...args], { timeout: 5000 });
      await git('init', '--quiet');
      await writeFile(join(staging, 'example.txt'), 'Baseline');
      await writeFile(join(staging, 'remove.txt'), 'Original');
      await git('add', '.');
      await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Baseline');
      const base = (await git('rev-parse', 'HEAD')).stdout.trim();
      const remoteIdentity = await identifyStage3Source(staging);
      const staged = createStage3DeltaStage({ sourceRoot: staging, sourceIdentity: remoteIdentity, base, stateDir: join(root, 'stage-state') });
      const source = { root: staging, identity: remoteIdentity, computerId: 'fixture-source' };
      const destination = { root: mirror, identity: await identifyStage3Target(mirror), handle: target.handle, containerId: target.containerId };
      const selection = { runtime: target.runtime, worktree: target.worktree, generation: 'a'.repeat(64) };
      const receiver = createStage3SourceSync({
        stateDir: join(root, 'receiver-state'),
        bindings: [{ ...selection, owner, expiresAt: Date.now() + 60_000, source, target: destination }],
        authenticate: async (credential: () => Promise<void>) => { await credential(); return owner; },
        readBinding: async () => ({ generation: selection.generation, source: { owner, ...source }, target: { owner, ...destination } }),
        testRevision: async () => {
          const assertion = 'const fs = require("node:fs"); const text = fs.readFileSync("example.txt", "utf8"); ' +
            'if (!text) process.exit(1); console.log("Validated " + text);';
          const { stdout } = await exec(process.execPath, ['-e', assertion], { cwd: mirror, timeout: 3000 });
          return { exitCode: 0, log: stdout };
        },
      });
      const { post, approve } = fixture(async (_binding, delta, assertCurrent) =>
        staged(delta, async () => receiver.syncAndTest(assertCurrent, selection), { beforeWrite: assertCurrent }));
      const { approvalId, pollSecret } = await (await post(pair, { sourceIdentity })).json();
      expect((await approve(approvalId)).status).toBe(303);
      const { bearer } = await (await post(poll, { pollSecret })).json();
      const file = (path: string, content: string) => ({ kind: 'file' as const, path, mode: 420 as const, content: Buffer.from(content).toString('base64') });
      const sync = async (entries: DevstackSourceDelta['entries']) => {
        const response = await post('/devstack/cli/source', { base, entries }, { authorization: 'Bearer ' + bearer });
        expect(response.status).toBe(200);
        return await response.json() as DevstackSourceReceipt;
      };
      const original = await sync([]);
      const first = await sync([file('example.txt', 'First'), file('added.txt', 'New'), { kind: 'delete', path: 'remove.txt' }]);
      expect(first.test).toEqual({ revision: first.revision, exitCode: 0, log: 'Validated First' });
      await expect(readFile(join(mirror, 'added.txt'), 'utf8')).resolves.toBe('New');
      await expect(readFile(join(mirror, 'remove.txt'), 'utf8')).rejects.toHaveProperty('code', 'ENOENT');
      const second = await sync([file('example.txt', 'Second')]);
      expect(second.test).toEqual({ revision: second.revision, exitCode: 0, log: 'Validated Second' });
      expect(second.revision).not.toBe(first.revision);
      expect(await sync([file('example.txt', 'Second')])).toMatchObject({ revision: second.revision, updated: 0, removed: 0 });
      expect(await sync([])).toMatchObject({ revision: original.revision, test: { exitCode: 0, log: 'Validated Baseline' } });
      await expect(readFile(join(mirror, 'remove.txt'), 'utf8')).resolves.toBe('Original');
      await expect(readFile(join(mirror, 'added.txt'), 'utf8')).rejects.toHaveProperty('code', 'ENOENT');
      expect((await git('status', '--porcelain')).stdout).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid routes, bodies, origins and spoofed hosts', async () => {
    const { request, post } = fixture();
    expect((await post(pair, { sourceIdentity, owner })).status).toBe(400);
    expect((await post(pair, { sourceIdentity: 'f'.repeat(64) })).status).toBe(404);
    expect((await post(pair, { sourceIdentity }, { host: 'other.test' })).status).toBe(404);
    expect((await post(pair, { sourceIdentity }, { origin: 'https://other.test' })).status).toBe(403);
    expect((await post(pair, { sourceIdentity: 'x'.repeat(2048) })).status).toBe(413);
    expect((await request(pair + '/untrusted')).status).toBe(404);
    expect((await request('/api/devstack/runs')).status).toBe(404);
    expect((await request('/devstack/cli/unknown')).status).toBe(404);
  });
});
