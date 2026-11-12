import { createServer } from 'node:http';
import { MatrixComputerListSchema } from '@matrix-os/contracts';
import { Hono } from 'hono';
import { WebSocket, WebSocketServer } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { bootstrapDevstackIdentity } from '../../packages/platform/src/devstack-bootstrap.js';
import { createDevstackPreviewRoutes } from '../../packages/platform/src/devstack-preview-routes.js';
import { createDevstackPublicPreviewAccess } from '../../packages/platform/src/devstack-public-preview.js';
import { resolveRegisteredRuntimeEndpoint } from '../../packages/platform/src/devstack-registered-runtime.js';
import { loadDevstackPreviewConfig } from '../../packages/platform/src/devstack-runs/config.js';
import { createApp } from '../../packages/platform/src/main.js';
import { registerPlatformWebSocketUpgradeHandler } from '../../packages/platform/src/platform-websocket-upgrade.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { JWT_SECRET, stubOrchestrator } from './proxy-routing-test-utils.js';

const origin = 'https://devstack.example.test';
const host = new URL(origin).host;
const issuer = 'https://clerk.example.test';
const owner = 'user_preview_owner';
const peer = 'user_preview_peer';
const instance = 'stage-three';
const root = '/vm/dev-one/';
const worktreeRoot = '/devstack/worktrees/feature-one/';
const target = {
  runtime: 'first', worktree: 'feature-one', owner, handle: 'dev-one', containerId: 'a'.repeat(64),
};
const env = {
  PLATFORM_RUNTIME_MODE: 'local', MATRIX_APP_ORIGIN: origin, MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: 'true',
};
const config = loadDevstackPreviewConfig(JSON.stringify({
  issuer, previewOrigin: origin, operators: [owner, peer], targets: [target], publicBrowserOnly: true,
}), instance)!;

function fixtureClerk() {
  return createClerkAuth({ async verifyToken(token) {
    if (!['owner', 'peer', 'outsider', 'expired', 'pending', 'wrong-issuer'].includes(token)) throw new Error('Invalid fixture');
    return {
      sub: token === 'peer' ? peer : token === 'outsider' ? 'user_preview_outsider' : owner,
      iss: token === 'wrong-issuer' ? 'https://unexpected.example.test' : issuer,
      sid: 'sess_fixture', exp: Math.floor(Date.now() / 1000) + (token === 'expired' ? -60 : 60),
      ...(token === 'pending' ? { sts: 'pending' } : {}),
    };
  } });
}

describe('public Stage 3 browser entry', () => {
  it('applies the enrolled owner and current membership before direct HTTP and blocks platform routes', async () => {
    vi.stubEnv('MATRIX_APP_DOMAIN_HOSTS', host);
    vi.stubEnv('PLATFORM_JWT_SECRET', JWT_SECRET);
    const { db } = await createTestPlatformDb();
    const clerkAuth = fixtureClerk();
    const isMember = vi.fn(async () => true);
    const resolve = vi.fn(() => resolveRegisteredRuntimeEndpoint(
      db, instance, { source: 'auth', userId: owner, handle: target.handle }, target.handle, 'primary',
    ));
    const deps = { config, clerkAuth, isMember, resolve, publishableKey: 'pk_test_preview_fixture' };
    const app = createApp({
      db, orchestrator: stubOrchestrator(), clerkAuth, registeredRuntimeInstance: instance, env, platformSecret: 'platform-secret-test',
      devstackPreviewRoutes: createDevstackPreviewRoutes(deps),
      devstackPublicPreview: createDevstackPublicPreviewAccess(deps),
    });
    try {
      await bootstrapDevstackIdentity(db, {
        instance, clerkUserId: owner, handle: target.handle, email: 'owner@example.test', displayName: 'Owner',
        containerId: target.containerId, gatewayPort: 4000, shellPort: 3000,
      });
      const upstream = vi.fn(async (_url: string, _init?: RequestInit) => new Response('registered Shell', { headers: { 'cache-control': 'public, max-age=10000' } }));
      vi.stubGlobal('fetch', upstream);
      const request = (path: string, cookie?: string, extra: Record<string, string> = {}, method = 'GET') =>
        app.request(`${origin}${path}`, { method, headers: { host, ...(cookie ? { cookie: `__session=${cookie}` } : {}), ...extra } });

      expect((await request('/')).headers.get('location')).toBe('/devstack');
      expect((await request('/devstack', 'owner')).headers.get('location')).toBe(worktreeRoot);
      expect(isMember).toHaveBeenCalledWith(owner, 'owner');
      expect((await request('/devstack', 'owner', { host: `${host}:443` })).headers.get('location')).toBe(worktreeRoot);
      const inventory = await request('/api/auth/computers', 'owner', { referer: `${origin}${root}` });
      expect(inventory.status).toBe(200);
      expect(inventory.headers.get('cache-control')).toBe('private, no-store');
      expect(MatrixComputerListSchema.parse(await inventory.json())).toEqual({
        items: [{ handle: 'dev-one', runtimeSlot: 'primary', label: 'Preview Computer', availability: 'available',
          kind: 'preview', gatewayPath: '/vm/dev-one', capabilities: ['matrixComputerInventoryV1'] }],
        hasMore: false, limit: 1, selectedSlot: 'primary',
      });
      const all = await request('/runtime?_rsc=fixture', 'owner');
      expect(all.headers.get('location')).toBe('/devstack/computers');
      const chooser = await request('/devstack/computers', 'owner');
      expect(chooser.status).toBe(200);
      expect(await chooser.text()).toContain('href="/devstack/worktrees/feature-one/"');
      expect((await request('/devstack/first/feature-one', 'owner')).headers.get('location')).toBe(root);
      expect(await (await request('/devstack/computers')).text()).toContain('var redirectTarget = "/devstack/computers"');
      expect((await request(root)).headers.get('location')).toBe('/sign-in?redirect_url=%2Fvm%2Fdev-one%2F');
      expect((await request(root, 'peer', { host: `${host}:443` })).status).toBe(404);
      expect((await request('/health', undefined, { host: `${host}:443` })).status).toBe(404);
      expect((await request('/health', undefined, { host: 'localhost' })).status).toBe(200);
      expect((await request(root, 'expired')).status).toBe(401);
      expect((await request(root, 'wrong-issuer')).status).toBe(403);
      expect((await request(root, 'pending')).status).toBe(403);
      expect((await request(root, 'outsider')).status).toBe(403);
      expect((await request(root, 'peer')).status).toBe(404);
      expect((await request('/vm/dev-other/', 'owner')).status).toBe(404);
      expect((await request('/vm/dev-one/~runtime/peer/', 'owner')).status).toBe(404);
      expect((await request('/vm/dev-one/internal/ai/funded', 'owner')).status).toBe(404);
      expect((await request('/vm/dev-one/in%74ernal/ai/funded', 'owner')).status).toBe(404);
      expect((await request('/vm/dev-one//internal/ai/funded', 'owner')).status).toBe(404);
      for (const path of ['/internal/ai/funded', '/api/devstack/runs', '/api/computers', '/health', '/_next/static/test.js']) {
        expect((await request(path, 'owner', { 'x-forwarded-host': 'app.matrix-os.com' })).status).toBe(404);
      }
      const signIn = '/sign-in?redirect_url=%2Fvm%2Fdev-one%2F';
      expect(await (await request(signIn)).text()).toContain('var redirectTarget = "/vm/dev-one/"');
      expect((await request(signIn, 'owner')).headers.get('location')).toBe(root);
      expect((await request('/sign-in?redirect_url=https%3A%2F%2Foutside.example', 'owner')).status).toBe(400);
      isMember.mockResolvedValueOnce(false);
      expect((await request(root, 'owner')).status).toBe(403);
      isMember.mockRejectedValueOnce(new Error('fixture membership unavailable'));
      expect((await request(root, 'owner')).status).toBe(503);
      resolve.mockResolvedValueOnce({
        source: 'record', handle: target.handle, clerkUserId: owner, containerId: 'b'.repeat(64),
        host: 'fixture-upstream', port: 4000, shellPort: 3000, status: 'running',
      });
      expect((await request(root, 'owner')).status).toBe(404);
      expect(upstream).not.toHaveBeenCalled();
      const response = await request(root, 'owner', { authorization: 'Bearer peer' });
      expect(await response.text()).toBe('registered Shell');
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(new Headers(upstream.mock.calls[0]?.[1]?.headers).get('x-platform-user-id')).toBe(owner);

      const worktreeSignIn = '/sign-in?redirect_url=%2Fdevstack%2Fworktrees%2Ffeature-one%2F';
      const anonymous = await request(worktreeRoot);
      expect(anonymous.status).toBe(302);
      expect(anonymous.headers.get('location')).toBe(worktreeSignIn);
      expect(await (await request(worktreeSignIn)).text()).toContain('var redirectTarget = "/devstack/worktrees/feature-one/"');
      expect((await request(worktreeSignIn, 'owner')).headers.get('location')).toBe(worktreeRoot);
      expect((await request(worktreeSignIn, 'peer')).status).toBe(404);
      for (const denied of [
        '/devstack/worktrees/feature%2Done/', '/devstack/worktrees/unregistered/',
        `${worktreeRoot}~runtime/peer/_next/static/chunk.js`, `${worktreeRoot}in%74ernal/ai/funded`,
        `${worktreeRoot}api/devstack/runs`,
      ]) expect((await request(denied, 'owner')).status).toBe(404);
      expect((await request(worktreeRoot, 'peer')).status).toBe(404);
      expect((await request(`${worktreeRoot}api/system/info`)).status).toBe(401);

      for (let load = 0; load < 2; load += 1) {
        const document = await request(worktreeRoot, 'owner');
        expect(document.status).toBe(200);
        expect(document.headers.has('location')).toBe(false);
        expect(document.headers.get('cache-control')).toBe('private, no-store');
        expect(await document.text()).toBe('registered Shell');
        expect(upstream.mock.lastCall?.[0]).toBe('http://matrixos-dev-one:3000/');
      }
      expect((await request(`${worktreeRoot}api/system/info`, 'owner')).status).toBe(200);
      expect(upstream.mock.lastCall?.[0]).toBe('http://matrixos-dev-one:4000/api/system/info');
      expect((await request(`${worktreeRoot}~runtime/primary/_next/static/chunk.js`, 'owner')).status).toBe(200);
      expect(upstream.mock.lastCall?.[0]).toBe('http://matrixos-dev-one:3000/_next/static/chunk.js');
      upstream.mockResolvedValueOnce(new Response('session', { headers: {
        'set-cookie': 'matrix_app_session__sample=fixture; Path=/apps/sample/; HttpOnly; Secure',
      } }));
      const session = await request(`${worktreeRoot}api/apps/sample/session`, 'owner', { origin }, 'POST');
      expect(session.headers.get('set-cookie')).toContain(`Path=${worktreeRoot}apps/sample/`);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await app.shutdownPostHog();
      await destroyTestPlatformDb(db);
    }
  });

  it('selects only the current registered worktree and keeps the chooser owner scoped', async () => {
    const second = { runtime: 'second', worktree: 'feature-two', owner, handle: 'dev-two', containerId: 'b'.repeat(64) };
    const other = { runtime: 'third', worktree: 'peer-only', owner: peer, handle: 'dev-peer', containerId: 'c'.repeat(64) };
    const config = loadDevstackPreviewConfig(JSON.stringify({
      issuer, previewOrigin: origin, operators: [owner, peer], targets: [target, second, other], publicBrowserOnly: true,
    }), instance)!;
    const isMember = vi.fn(async () => true);
    const resolve = vi.fn(async (entry: typeof target) => ({
      source: 'record' as const, handle: entry.handle, clerkUserId: entry.owner, containerId: entry.containerId,
      host: 'fixture-upstream', port: 4000, shellPort: 3000, status: 'running' as const,
    }));
    const deps = { config, clerkAuth: fixtureClerk(), isMember, resolve, publishableKey: 'pk_test_preview_fixture' };
    const app = new Hono();
    app.use('*', createDevstackPublicPreviewAccess(deps).middleware);
    app.route('/', createDevstackPreviewRoutes(deps));
    const inventory = '/api/auth/computers';
    const request = (path: string, actor?: string, referer?: string, method = 'GET') =>
      app.request(`${origin}${path}`, { method, headers: { host, ...(actor ? { cookie: `__session=${actor}` } : {}),
        ...(referer ? { referer } : {}) } });

    expect((await request(inventory)).status).toBe(401);
    expect((await request(inventory, 'outsider', `${origin}${root}`)).status).toBe(403);
    expect((await request(inventory, 'peer', `${origin}${root}`)).status).toBe(404);
    expect((await request(inventory, 'owner', `${origin}/vm/dev-peer/`)).status).toBe(404);
    expect((await request(inventory, 'owner', 'https://other.example/vm/dev-one/')).status).toBe(404);
    expect((await request(inventory, 'owner')).status).toBe(404);
    expect((await request(inventory, 'owner', `${origin}${root}`, 'POST')).status).toBe(404);
    expect(resolve).not.toHaveBeenCalled();

    const current = await request(inventory, 'owner', `${origin}/vm/dev-two/?stage3=true`);
    expect(current.status).toBe(200);
    expect(MatrixComputerListSchema.parse(await current.json()).items.map(item => item.handle)).toEqual(['dev-two']);
    expect(resolve).toHaveBeenLastCalledWith(second);
    const canonical = await request(inventory, 'owner', `${origin}/devstack/worktrees/feature-two/`);
    expect(canonical.status).toBe(200);
    expect(MatrixComputerListSchema.parse(await canonical.json()).items.map(item => item.handle)).toEqual(['dev-two']);
    expect(resolve).toHaveBeenLastCalledWith(second);
    const fallback = await request(inventory, 'peer');
    expect(fallback.status).toBe(200);
    expect(MatrixComputerListSchema.parse(await fallback.json()).items.map(item => item.handle)).toEqual(['dev-peer']);

    isMember.mockResolvedValueOnce(false);
    expect((await request(inventory, 'owner', `${origin}${root}`)).status).toBe(403);
    resolve.mockImplementationOnce(async entry => ({
      source: 'record', handle: entry.handle, clerkUserId: entry.owner, containerId: other.containerId,
      host: 'fixture-upstream', port: 4000, shellPort: 3000, status: 'running',
    }));
    expect((await request(inventory, 'owner', `${origin}${root}`)).status).toBe(404);

    const chooser = await (await request('/devstack/computers', 'owner')).text();
    expect(chooser).toContain('href="/devstack/worktrees/feature-one/"');
    expect(chooser).toContain('href="/devstack/worktrees/feature-two/"');
    expect(chooser).not.toContain('peer-only');
    expect((await request('/devstack/third/peer-only', 'owner')).status).toBe(404);
  });

  it('requires the same verified owner and browser origin for HMR and rejects non-browser upgrade routes', async () => {
    vi.stubEnv('MATRIX_APP_DOMAIN_HOSTS', host);
    const { db } = await createTestPlatformDb();
    const server = createServer();
    const clerkAuth = fixtureClerk();
    const isMember = vi.fn(async () => false);
    const resolve = vi.fn<() => ReturnType<typeof resolveRegisteredRuntimeEndpoint>>(async () => null);
    const devstackPublicPreview = createDevstackPublicPreviewAccess({
      config, clerkAuth, isMember, resolve, publishableKey: 'pk_test_preview_fixture',
    });
    const decision = { runtimeProxyAllowed: true } as never;
    registerPlatformWebSocketUpgradeHandler({
      server, app: { capturePlatformEvent: vi.fn() }, db, registeredRuntimeInstance: instance,
      clerkAuth, devstackPublicPreview, env, platformSecret: 'platform-secret-test', platformJwtSecret: JWT_SECRET,
      legacyContainerRoutingEnabled: true, codeServerPort: 8080, getRuntimeEntitlementDecision: () => decision,
      getRuntimeEntitlementDecisionForUser: async () => decision,
    });
    const shell = createServer();
    const upstream = new WebSocketServer({ server: shell });
    const receivedPaths: Array<string | undefined> = [];
    upstream.on('connection', (ws, req) => {
      receivedPaths.push(req.url);
      ws.send('fixture HMR update');
    });
    try {
      await new Promise<void>(done => shell.listen(0, '127.0.0.1', done));
      const shellAddress = shell.address();
      if (!shellAddress || typeof shellAddress === 'string') throw new Error('fixture shell listener unavailable');
      await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('fixture listener unavailable');
      const socket = (path: string, cookie?: string, requestOrigin = origin, requestHost = host) => new Promise<number | string>((done, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, {
          origin: requestOrigin, handshakeTimeout: 1000,
          headers: { host: requestHost, ...(cookie ? { cookie: `__session=${cookie}` } : {}) },
        });
        ws.once('unexpected-response', (_request, response) => {
          response.resume();
          ws.terminate();
          done(response.statusCode ?? 0);
        });
        ws.once('error', reject);
        ws.once('message', value => { ws.close(); done(value.toString()); });
      });
      const hmr = '/vm/dev-one/~runtime/primary/_next/webpack-hmr';
      expect(await socket(hmr)).toBe(401);
      expect(await socket(hmr, 'owner', 'https://other.example')).toBe(403);
      expect(await socket(hmr, 'owner')).toBe(403);
      expect(await socket(hmr, 'owner', origin, `${host}:443`)).toBe(403);
      isMember.mockResolvedValue(true);
      expect(await socket(hmr, 'peer')).toBe(404);
      expect(await socket('/ws', 'owner')).toBe(404);
      expect(await socket('/internal/gemini-live', 'owner')).toBe(404);
      expect(await socket('/vm/dev-one/internal/gemini-live', 'owner')).toBe(404);
      expect(resolve).not.toHaveBeenCalled();
      expect(await socket(hmr, 'owner')).toBe(404);
      expect(resolve).toHaveBeenCalledTimes(1);
      resolve.mockResolvedValue({
        source: 'record', handle: target.handle, clerkUserId: owner, containerId: target.containerId,
        host: '127.0.0.1', port: 1, shellPort: shellAddress.port, status: 'running',
      });
      const nextHmr = '/vm/dev-one/~runtime/primary/_next/hmr';
      expect(await socket(hmr, 'owner')).toBe('fixture HMR update');
      expect(await socket(nextHmr, 'owner')).toBe('fixture HMR update');
      const canonicalHmr = `${worktreeRoot}~runtime/primary/_next/hmr?id=fixture`;
      expect(await socket(canonicalHmr)).toBe(401);
      expect(await socket(canonicalHmr, 'owner', 'https://other.example')).toBe(403);
      expect(await socket(canonicalHmr, 'peer')).toBe(404);
      expect(await socket(canonicalHmr, 'owner')).toBe('fixture HMR update');
      expect(receivedPaths).toEqual([hmr, nextHmr, canonicalHmr]);
    } finally {
      for (const client of upstream.clients) client.terminate();
      await new Promise<void>(done => upstream.close(() => done()));
      await new Promise<void>(done => shell.close(() => done()));
      await new Promise<void>(done => server.close(() => done()));
      vi.unstubAllEnvs();
      await destroyTestPlatformDb(db);
    }
  });
});
