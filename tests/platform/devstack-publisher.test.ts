import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createStage3Publisher, listenStage3Publisher } from '../../scripts/devstack/stage3-publisher.mjs';
import { identifyStage3Source, identifyStage3Target } from '../../scripts/devstack/stage3-source.mjs';
import { createDevstackPublisherClient } from '../../packages/platform/src/devstack-publisher-client.js';
import { createDevstackHostedAccess } from '../../packages/platform/src/devstack-hosted-access.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { loadDevstackPreviewConfig } from '../../packages/platform/src/devstack-runs/config.js';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';

const exec = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(testRevision?: (binding: unknown, revision: string, signal: AbortSignal) => Promise<{ exitCode: number; log: string }>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'devstack-publisher-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const staging = join(root, 'staging');
  const mirror = join(root, 'mirror');
  await Promise.all([mkdir(staging, { mode: 0o700 }), mkdir(mirror, { mode: 0o700 })]);
  const git = (...args: string[]) => exec('git', ['-C', staging, ...args], { timeout: 5000 });
  await git('init', '-q');
  await writeFile(join(staging, 'example.txt'), 'Baseline');
  await git('add', '.');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Baseline');
  const base = (await git('rev-parse', 'HEAD')).stdout.trim();
  const binding = { owner: 'user_owner', runtime: 'runtime-one', worktree: 'worktree-one',
    handle: 'dev-one', containerId: 'a'.repeat(64), sourceIdentity: 'b'.repeat(64), clerkSessionId: 'sess_fixture' };
  const enrollment = { ...binding, generation: 'c'.repeat(64), expiresAt: Date.now() + 60_000, base,
    source: { root: staging, identity: await identifyStage3Source(staging), computerId: 'fixture-main' },
    target: { root: mirror, identity: await identifyStage3Target(mirror), handle: binding.handle, containerId: binding.containerId } };
  const publisher = createStage3Publisher({ enrollment, stateDir: join(root, 'state'),
    testRevision: testRevision ?? (async () => ({ exitCode: 0, log: 'Validated ' + await readFile(join(mirror, 'example.txt'), 'utf8') })) });
  const socketPath = join(root, 'publisher.sock');
  const server = await listenStage3Publisher({ socketPath, publisher });
  cleanups.push(() => server.close());
  const client = createDevstackPublisherClient({ socketPath, identity: binding.sourceIdentity });
  const file = (content: string) => ({ base, entries: [{ path: 'example.txt', kind: 'file' as const, mode: 420 as const,
    content: Buffer.from(content).toString('base64') }] });
  return { root, staging, mirror, publisher, socketPath, client, binding, base, file };
}

describe('dedicated DevStack publisher transport', () => {
  it('wires the production startup factory through pairing, trusted approval, ingress and the private publisher', async () => {
    let holdTest = false;
    let started!: () => void;
    let cancelled!: () => void;
    const testStarted = new Promise<void>(resolve => { started = resolve; });
    const testCancelled = new Promise<void>(resolve => { cancelled = resolve; });
    const f = await fixture(async (_binding, _revision, signal) => {
      if (!holdTest) return { exitCode: 0, log: 'Validated ' + await readFile(join(f.mirror, 'example.txt'), 'utf8') };
      started();
      try { await delay(30_000, undefined, { signal }); }
      finally { cancelled(); }
      return { exitCode: 0, log: 'Unexpected completion' };
    });
    const previewOrigin = 'https://devstack.example.test', approvalOrigin = 'https://approve.example.test';
    const { sourceIdentity, clerkSessionId: _session, ...target } = f.binding;
    const issuer = 'https://clerk.example.test';
    let membershipChecks = 0, revokeAt = Infinity;
    const clerkAuth = createClerkAuth({ verifyToken: async token => {
      if (token !== 'fixture-owner') throw new Error('Invalid fixture token');
      return { sub: target.owner, sid: 'sess_fixture', azp: approvalOrigin, exp: Math.floor(Date.now() / 1000) + 60, iss: issuer };
    } });
    const access = createDevstackHostedAccess({
      config: loadDevstackPreviewConfig(JSON.stringify({ issuer, previewOrigin, operators: [target.owner], targets: [target], publicBrowserOnly: true }), 'stage-three')!,
      clerkAuth, approvalClerkAuth: clerkAuth,
      isMember: async () => ++membershipChecks < revokeAt, publishableKey: 'pk_test_fixture',
      resolve: async () => ({ handle: target.handle, clerkUserId: target.owner, containerId: target.containerId,
        source: 'record', host: '127.0.0.1', port: 4000, shellPort: 3000, status: 'running' }),
    }, { MATRIX_DEVSTACK_CLI_PILOT_WORKTREE: target.worktree,
      MATRIX_DEVSTACK_SOURCE_PUBLISHER: JSON.stringify({ socketPath: f.socketPath, identity: sourceIdentity, approvalOrigin }) });
    const app = new Hono();
    app.use('*', access.devstackPublicPreview!.middleware);
    app.route('/', access.devstackCliRoutes!);
    const post = (path: string, body: unknown, bearer?: string) => app.request(previewOrigin + path, {
      method: 'POST', headers: { host: new URL(previewOrigin).hostname, 'content-type': 'application/json', ...(bearer && { authorization: 'Bearer ' + bearer }) },
      body: JSON.stringify(body),
    });
    const pair = await post('/devstack/cli/pair', { sourceIdentity });
    expect(pair.status).toBe(201);
    const { approvalId, pollSecret, approvalOrigin: returnedOrigin } = await pair.json();
    expect(returnedOrigin).toBe(approvalOrigin);
    const approved = await app.request(approvalOrigin + '/devstack/cli/pair/' + approvalId, {
      method: 'POST', headers: { host: new URL(approvalOrigin).hostname, origin: approvalOrigin, cookie: '__session=fixture-owner' },
      body: new URLSearchParams({ worktree: target.worktree }),
    });
    expect(approved.status).toBe(303);
    const { bearer } = await (await post('/devstack/cli/poll', { pollSecret })).json();
    for (const content of ['First', 'Second']) {
      const response = await post('/devstack/cli/source', f.file(content), bearer);
      expect(response.status).toBe(200);
      const receipt = await response.json();
      expect(receipt.test).toEqual({ revision: receipt.revision, exitCode: 0, log: 'Validated ' + content });
      expect(await readFile(join(f.mirror, 'example.txt'), 'utf8')).toBe(content);
    }
    const restored = await post('/devstack/cli/source', { base: f.base, entries: [] }, bearer);
    expect(restored.status).toBe(200);
    expect(await readFile(join(f.mirror, 'example.txt'), 'utf8')).toBe('Baseline');

    // A real TCP disconnect must reach the private socket and release the sole
    // publication slot; app.request alone cannot prove the Node adapter wiring.
    const http = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    cleanups.push(async () => {
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    });
    await new Promise<void>(resolve => http.once('listening', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('fixture HTTP listener unavailable');
    holdTest = true;
    const controller = new AbortController();
    const disconnected = new Promise<string>(resolve => {
      const request = httpRequest(`http://127.0.0.1:${address.port}/devstack/cli/source`, {
        method: 'POST', headers: { host: new URL(previewOrigin).hostname, 'content-type': 'application/json', authorization: 'Bearer ' + bearer },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
      }, response => { response.resume(); resolve('completed ' + response.statusCode); });
      request.once('error', () => resolve('aborted'));
      request.end(JSON.stringify(f.file('Interrupted')));
    });
    try {
      await expect(Promise.race([testStarted.then(() => 'started'), disconnected, delay(2000).then(() => 'timeout')])).resolves.toBe('started');
      controller.abort();
      await expect(disconnected).resolves.toBe('aborted');
      await expect(Promise.race([testCancelled.then(() => true), delay(2000).then(() => false)])).resolves.toBe(true);
    } finally { controller.abort(); holdTest = false; }
    // Cancellation does not undo a completed publication. Reconcile explicitly
    // with the baseline; wait only for the old job to release its final lock.
    let recovered: Response | undefined;
    for (let attempt = 0; attempt < 40; attempt++) {
      recovered = await post('/devstack/cli/source', { base: f.base, entries: [] }, bearer);
      if (recovered.status === 200) break;
      await delay(25);
    }
    expect(recovered?.status).toBe(200);
    expect(await readFile(join(f.mirror, 'example.txt'), 'utf8')).toBe('Baseline');
    revokeAt = membershipChecks + 5;
    const revoked = await post('/devstack/cli/source', f.file('Revoked'), bearer);
    expect(revoked.status).toBe(409);
    expect(await readFile(join(f.mirror, 'example.txt'), 'utf8')).toBe('Baseline');
  });

  it('sends two uncommitted deltas over a real private socket, returns matching logs and restores the exact baseline', async () => {
    const f = await fixture();
    let checks = 0;
    const assertCurrent = async () => { checks++; };
    expect((await lstat(f.socketPath)).mode & 0o777).toBe(0o600);
    const baseline = await f.client.apply(f.binding, { base: f.base, entries: [] }, assertCurrent);
    const first = await f.client.apply(f.binding, f.file('First'), assertCurrent);
    expect(first.test).toEqual({ revision: first.revision, exitCode: 0, log: 'Validated First' });
    const second = await f.client.apply(f.binding, f.file('Second'), assertCurrent);
    expect(second.revision).not.toBe(first.revision);
    expect(second.test).toEqual({ revision: second.revision, exitCode: 0, log: 'Validated Second' });
    expect(checks).toBeGreaterThanOrEqual(12);
    expect(await readFile(join(f.mirror, 'example.txt'), 'utf8')).toBe('Second');
    const restored = await f.client.apply(f.binding, { base: f.base, entries: [] }, assertCurrent);
    expect(restored.revision).toBe(baseline.revision);
    expect(await readFile(join(f.staging, 'example.txt'), 'utf8')).toBe('Baseline');
  });

  it.each(['owner', 'runtime', 'worktree', 'handle', 'containerId', 'sourceIdentity'] as const)(
    'rejects a mismatched %s before touching source', async key => {
      const f = await fixture();
      await expect(f.client.apply({ ...f.binding, [key]: 'wrong' }, f.file('Unwanted'), async () => {})).rejects.toThrow();
      expect(await readFile(join(f.staging, 'example.txt'), 'utf8')).toBe('Baseline');
    },
  );

  it('rechecks live authority across the socket immediately before publication', async () => {
    const f = await fixture();
    await f.client.apply(f.binding, { base: f.base, entries: [] }, async () => {});
    let checks = 0;
    await expect(f.client.apply(f.binding, f.file('Revoked'), async () => {
      // Initial client check, publisher admission, staging beforeWrite, receiver admission.
      if (++checks >= 5) throw new Error('Revoked');
    })).rejects.toThrow();
    expect(checks).toBeGreaterThanOrEqual(5);
    expect(await readFile(join(f.mirror, 'example.txt'), 'utf8')).toBe('Baseline');
  });

  it('rejects an already disconnected request before staging any source', async () => {
    const f = await fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.client.apply(f.binding, f.file('Unwanted'), async () => {}, controller.signal)).rejects.toThrow();
    expect(await readFile(join(f.staging, 'example.txt'), 'utf8')).toBe('Baseline');
  });

  it('refuses a world-accessible socket directory and never replaces an existing socket', async () => {
    const f = await fixture();
    await expect(listenStage3Publisher({ socketPath: f.socketPath, publisher: f.publisher })).rejects.toThrow();
    await chmod(f.root, 0o755);
    await expect(listenStage3Publisher({ socketPath: join(f.root, 'other.sock'), publisher: f.publisher })).rejects.toThrow();
    await expect(f.client.apply(f.binding, f.file('Unwanted'), async () => {})).rejects.toThrow();
  });
});
