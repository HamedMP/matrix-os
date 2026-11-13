import type Dockerode from 'dockerode';
import { resolveContainerEndpoint } from '../../packages/platform/src/container-endpoint.js';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { Agent } from 'undici';
import { WebSocket, WebSocketServer } from 'ws';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../packages/platform/src/main.js';
import { createSessionRoutingMiddleware } from '../../packages/platform/src/session-routing-middleware.js';
import { registerPlatformWebSocketUpgradeHandler } from '../../packages/platform/src/platform-websocket-upgrade.js';
import { issueSyncJwt } from '../../packages/platform/src/sync-jwt.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { buildPlatformUserProof } from '../../packages/platform/src/session-routing-websocket.js';
import { deriveEntitlementAccess } from '../../packages/platform/src/profile-routing.js';
import { bootstrapDevstackIdentity, type DevstackBootstrapInput } from '../../packages/platform/src/devstack-bootstrap.js';
import {
  createPlatformDb, getContainer, getPlatformUserByClerkId, insertUserMachine, type PlatformDB,
} from '../../packages/platform/src/db.js';
import { JWT_SECRET, stubDocker, stubOrchestrator } from './proxy-routing-test-utils.js';

const PRIVATE_ALIAS = 'matrixos-devstack-fixture';
const PLATFORM_SECRET = 'fixture-only-devstack-platform-secret';
const OWNER = 'user_devstack_fixture';

// Keep the production TCP connection and handshake. Only map the private
// alias to the isolated loopback fixture in this process.
const tcp = vi.hoisted(() => ({ hosts: [] as string[], available: true }));
vi.mock('node:net', async importOriginal => {
  const net = await importOriginal<typeof import('node:net')>();
  return {
    ...net,
    createConnection(options: import('node:net').TcpNetConnectOpts, listener?: () => void) {
      tcp.hosts.push(options.host ?? '');
      if (!tcp.available || options.host !== 'matrixos-devstack-fixture') throw new Error('Private upstream unavailable');
      return net.createConnection({ ...options, host: '127.0.0.1' }, listener);
    },
  };
});

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;

// Optional in unit-only runs; the existing required PostgreSQL runner supplies
// the URL and rejects skipped/missing assertions for every assigned suite.
describe.skipIf(!connectionString)('DevStack identity initialization on PostgreSQL', () => {
  let admin: Kysely<Record<string, never>>;
  let db: PlatformDB;
  let other: PlatformDB;
  let schema: string;
  const input = (overrides: Partial<DevstackBootstrapInput> = {}): DevstackBootstrapInput => ({
    instance: 'demo-a', clerkUserId: 'user_devstack_fixture', handle: 'devstack-fixture',
    email: 'devstack@example.com', displayName: 'DevStack fixture',
    containerId: 'a'.repeat(64), gatewayPort: 4000, shellPort: 3000,
    ...overrides,
  });

  beforeEach(async () => {
    if (!connectionString) throw new Error('MATRIX_TEST_POSTGRES_URL is required for DevStack PostgreSQL qualification');
    const url = new URL(connectionString);
    if (!['127.0.0.1', '[::1]'].includes(url.hostname) || !/^\/[A-Za-z0-9_]+_test$/.test(url.pathname) || url.search || url.hash) {
      throw new Error('Disposable literal-loopback PostgreSQL test database required');
    }
    schema = `devstack_bootstrap_${randomUUID().replaceAll('-', '')}`;
    admin = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    const connect = () => createPlatformDb({ dialect: new PostgresDialect({ pool: new Pool({
      connectionString, max: 4, options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000`,
    }) }) });
    db = connect(); await db.ready;
    other = connect(); await other.ready;
  });

  afterEach(async () => {
    try { await Promise.all([db?.destroy(), other?.destroy()]); }
    finally {
      try { if (schema && admin) await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); }
      finally { await admin?.destroy(); }
    }
  });

  it('creates one real local user and runtime route without paid or VPS state', async () => {
    const receipt = await bootstrapDevstackIdentity(db, input());
    const account = await getPlatformUserByClerkId(other, input().clerkUserId);
    expect(account).toMatchObject({ id: receipt.userId, clerkId: input().clerkUserId,
      handle: input().handle, email: input().email, plan: 'free', status: 'active',
      containerId: `devstack:demo-a:${input().clerkUserId}`, pipedreamExternalId: null });
    expect(receipt.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getContainer(other, input().handle)).toMatchObject({
      clerkUserId: input().clerkUserId, containerId: input().containerId,
      port: 4000, shellPort: 3000, status: 'running',
    });
    expect((await other.executor.selectFrom('user_machines').selectAll().execute())).toEqual([]);
    expect((await other.executor.selectFrom('billing_entitlement_overrides').selectAll().execute())).toEqual([]);
  });

  it('keeps one identity across reruns and independent concurrent initializers', async () => {
    const receipts = await Promise.all([
      bootstrapDevstackIdentity(db, input()), bootstrapDevstackIdentity(other, input()),
    ]);
    expect(receipts[0].userId).toBe(receipts[1].userId);
    await other.executor.updateTable('users').set({ pipedream_external_id: receipts[0].userId })
      .where('id', '=', receipts[0].userId).execute();
    expect(await bootstrapDevstackIdentity(db, input())).toMatchObject({
      userId: receipts[0].userId, pipedreamExternalId: receipts[0].userId,
    });
    expect(await db.executor.selectFrom('users').select('id').execute()).toHaveLength(1);
    expect(await db.executor.selectFrom('containers').select('handle').execute()).toHaveLength(1);
  });

  it.each([
    { instance: 'another' }, { handle: 'another-handle' }, { containerId: 'b'.repeat(64) },
    { gatewayPort: 4999 }, { shellPort: 3999 },
  ])('refuses to repoint retained identity or routing: %j', async (override) => {
    const original = await bootstrapDevstackIdentity(db, input());
    await expect(bootstrapDevstackIdentity(other, input(override))).rejects.toThrow(/owned|ownership|registration/i);
    expect(await getPlatformUserByClerkId(db, input().clerkUserId)).toMatchObject({ id: original.userId,
      containerId: `devstack:demo-a:${input().clerkUserId}`, handle: input().handle });
    expect(await getContainer(db, input().handle)).toMatchObject({ containerId: input().containerId, port: 4000, shellPort: 3000 });
  });

  it('rolls back runtime registration when the real user projection fails', async () => {
    await sql`CREATE FUNCTION reject_devstack_user() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'fixture rejected user projection'; END;
    $$ LANGUAGE plpgsql`.execute(db.executor);
    await sql`CREATE TRIGGER reject_devstack_user BEFORE INSERT ON users
      FOR EACH ROW EXECUTE FUNCTION reject_devstack_user()`.execute(db.executor);
    await expect(bootstrapDevstackIdentity(db, input())).rejects.toThrow('fixture rejected user projection');
    expect(await db.executor.selectFrom('users').select('id').execute()).toEqual([]);
    expect(await db.executor.selectFrom('containers').select('handle').execute()).toEqual([]);
  });

  it('does not adopt a user projected by another environment', async () => {
    await bootstrapDevstackIdentity(db, input());
    await other.executor.updateTable('users').set({ container_id: 'clerk:foreign' })
      .where('clerk_id', '=', input().clerkUserId).execute();
    await expect(bootstrapDevstackIdentity(db, input())).rejects.toThrow(/owned|ownership/i);
    expect(await getPlatformUserByClerkId(db, input().clerkUserId)).toMatchObject({ containerId: 'clerk:foreign' });
  });

  it('cannot give a different Clerk owner and handle an occupied execution target', async () => {
    await bootstrapDevstackIdentity(db, input());
    await expect(bootstrapDevstackIdentity(other, input({ clerkUserId: 'user_other', handle: 'another' })))
      .rejects.toThrow(/target.*owned/i);
    expect(await getContainer(db, 'another')).toBeUndefined();
    expect(await getPlatformUserByClerkId(db, 'user_other')).toBeFalsy();
  });

  it.each([null, 'matrixos-existing'])('refuses an unresolved retained route %j before admitting another owner', async target => {
    const first = await bootstrapDevstackIdentity(db, input());
    await db.executor.updateTable('containers').set({ container_id: target })
      .where('handle', '=', input().handle).execute();
    await expect(bootstrapDevstackIdentity(other, input({ clerkUserId: 'user_peer', handle: 'peer' })))
      .rejects.toThrow(/reconcile/i);
    expect(await getContainer(db, 'peer')).toBeUndefined();
    expect(await getPlatformUserByClerkId(db, 'user_peer')).toBeFalsy();
    expect(await getPlatformUserByClerkId(db, input().clerkUserId)).toMatchObject({ id: first.userId });
    expect(await getContainer(db, input().handle)).toMatchObject({ containerId: target, clerkUserId: input().clerkUserId });
  });

  it('replays after normal Docker resolution reconciles an already owned legacy name', async () => {
    const first = await bootstrapDevstackIdentity(db, input());
    const name = 'matrixos-existing';
    await db.executor.updateTable('containers').set({ container_id: name }).where('handle', '=', input().handle).execute();
    const docker = { getContainer(id: string) {
      expect(id).toBe(name);
      return { inspect: async () => ({ Id: input().containerId, State: { Running: true }, NetworkSettings: { Networks: {} } }) };
    } } as unknown as Dockerode;
    await resolveContainerEndpoint(docker, other, input().handle, name);
    expect(await getContainer(db, input().handle)).toMatchObject({ containerId: input().containerId });
    expect(await bootstrapDevstackIdentity(db, input())).toEqual(first);
  });

  it('retains the same immutable target after a real endpoint lookup and identical replay', async () => {
    const first = await bootstrapDevstackIdentity(db, input());
    const docker = { getContainer(id: string) {
      expect(id).toBe(input().containerId);
      return { inspect: async () => ({ Id: input().containerId, State: { Running: true }, NetworkSettings: { Networks: {} } }) };
    } } as unknown as Dockerode;
    const route = await getContainer(other, input().handle);
    expect(await resolveContainerEndpoint(docker, other, input().handle, route?.containerId))
      .toMatchObject({ source: 'docker-id', containerId: input().containerId });
    expect(await bootstrapDevstackIdentity(db, input())).toEqual(first);
    await expect(bootstrapDevstackIdentity(db, input({containerId: 'matrixos-owned-name'}))).rejects.toThrow(/identity|registration/i);
  });

  it('cannot give another Clerk user an occupied local handle', async () => {
    const first = await bootstrapDevstackIdentity(db, input());
    await expect(bootstrapDevstackIdentity(other, input({ clerkUserId: 'user_another_fixture' })))
      .rejects.toThrow(/owned|ownership|registration/i);
    expect(await db.executor.selectFrom('users').select('id').execute()).toEqual([{ id: first.userId }]);
    expect(await getContainer(db, input().handle)).toMatchObject({ clerkUserId: input().clerkUserId });
  });

  it('proxies the registered owner over HTTP and WebSocket and refuses unsafe or stale registrations without repairing them', async () => {
    const requests: Array<{ path?: string; headers: IncomingMessage['headers'] }> = [];
    const observe = (req: IncomingMessage) => { requests.push({ path: req.url, headers: req.headers }); };
    const upstream = createServer((req, res) => {
      observe(req);
      if (req.url === '/api/redirect') {
        res.writeHead(302, { location: 'http://outside.invalid/' }).end();
        return;
      }
      if (req.url === '/api/apps/demo/session') {
        res.setHeader('set-cookie', 'matrix_app_session__demo=fixture; Path=/apps/demo/; HttpOnly; Secure');
      }
      res.end('registered gateway response');
    });
    const shell = createServer((req, res) => { observe(req); res.end('registered shell response'); });
    const sockets = new WebSocketServer({ server: upstream });
    sockets.on('connection', (socket, req) => {
      observe(req);
      socket.send('registered gateway socket');
    });
    const shellSockets = new WebSocketServer({ server: shell });
    shellSockets.on('connection', (socket, req) => {
      observe(req);
      socket.send('registered shell socket');
    });
    const platform = createServer();
    const httpHosts: string[] = [];
    const dispatcher = new Agent({ connect: { lookup(host, options, callback) {
      httpHosts.push(host);
      if (!tcp.available || host !== PRIVATE_ALIAS) {
        callback(new Error('Unexpected private upstream alias'), '', 4);
        return;
      }
      if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }], 4);
      else callback(null, '127.0.0.1', 4);
    } } });
    const docker = stubDocker();
    const orchestrator = stubOrchestrator();
    const clerkAuth = createClerkAuth({
      async verifyToken(token) {
        if (token !== 'synthetic-clerk-session') throw new Error('Unrecognized test session');
        return { sub: OWNER };
      },
    });
    const env = {
      MATRIX_DEVSTACK_REGISTERED_RUNTIMES_ONLY: 'true',
      MATRIX_DEVSTACK_INSTANCE: input().instance,
      MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED: 'true',
      PLATFORM_BACKGROUND_WORKERS_ENABLED: 'false',
      PLATFORM_RUNTIME_MODE: 'local',
    };
    let entitlementStatus: 'active' | 'missing' = 'active';
    const getEntitlement = () => deriveEntitlementAccess({ status: entitlementStatus });
    const registeredOptions = { registeredRuntimeInstance: input().instance };
    const routing = {
      db, docker, orchestrator, clerkAuth, platformSecret: PLATFORM_SECRET, platformJwtSecret: JWT_SECRET,
      legacyContainerRoutingEnabled: true, codeServerPort: 8080,
      getRuntimeEntitlementDecision: getEntitlement,
      getRuntimeEntitlementDecisionForUser: async () => getEntitlement(),
      ...registeredOptions,
    };
    const app = new Hono();
    app.use('*', createSessionRoutingMiddleware({
      ...routing, appEnv: env, proxyTimeoutMs: 1_000, authShellProxyTimeoutMs: 1_000,
      wsTokenExpiresInSec: 60, containerProxyDispatcher: dispatcher, customerVpsProxyDispatcher: dispatcher,
      applyNoStoreHeaders: () => {}, getGatewayUrlForHandle: () => 'https://app.matrix-os.com',
      logRouteError: () => {},
    }));
    registerPlatformWebSocketUpgradeHandler({
      ...routing, server: platform, env, app: { capturePlatformEvent: vi.fn() },
    });
    const token = async (clerkUserId = OWNER, handle = input().handle, runtimeSlot?: string) => (await issueSyncJwt({
      secret: JWT_SECRET, clerkUserId, handle, runtimeSlot, gatewayUrl: 'https://app.matrix-os.com',
    })).token;
    const headers = (jwt: string) => ({ host: 'app.matrix-os.com', authorization: `Bearer ${jwt}` });
    const http = (path: string, jwt: string) => app.request(`https://app.matrix-os.com${path}`, { headers: headers(jwt) });
    let platformPort: number;
    const ws = (path: string, jwt?: string): Promise<string | number> => new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${platformPort}${path}`, {
        headers: jwt === undefined ? { host: 'app.matrix-os.com' } : headers(jwt), handshakeTimeout: 1_000,
      });
      socket.once('message', (data) => { resolve(data.toString()); socket.close(); });
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        socket.terminate();
        resolve(response.statusCode ?? 0);
      });
      socket.once('error', reject);
    });
    try {
      const gatewayPort = await listen(upstream);
      const shellPort = await listen(shell);
      platformPort = await listen(platform);
      const route = input({ gatewayPort, shellPort });
      const registered = await bootstrapDevstackIdentity(db, route);
      await insertUserMachine(other, {
        machineId: '11111111-1111-4111-8111-111111111111',
        clerkUserId: OWNER, handle: 'unregistered-primary', runtimeSlot: 'primary', status: 'running',
        publicIPv4: null, imageVersion: 'dev', serverType: 'cpx22', provisionedAt: '2026-07-16T00:00:00.000Z',
      });
      const before = await db.executor.selectFrom('containers').selectAll().executeTakeFirstOrThrow();
      const owner = await token();
      const explicit = `/vm/${route.handle}`;
      const proxyAdmin = createApp({ ...routing, env });
      const adminFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('legacy bypass'));
      try {
        const bypass = await proxyAdmin.request(`http://platform.local/proxy/${route.handle}/api/probe`, {
          headers: { host: 'platform.local', authorization: `Bearer ${PLATFORM_SECRET}` },
        });
        expect.soft(bypass.status).toBe(404);
        expect.soft(adminFetch).not.toHaveBeenCalled();
      } finally {
        adminFetch.mockRestore();
        await proxyAdmin.shutdownPostHog();
      }

      for (const prefix of ['', explicit]) {
        const response = await http(`${prefix}/api/probe?kept=1`, owner);
        expect.soft(response.status).toBe(200);
        expect.soft(await response.text()).toBe('registered gateway response');
        expect.soft(await ws(`${prefix}/ws?kept=1`, owner)).toBe('registered gateway socket');
      }
      expect.soft(requests.map(request => request.path)).toEqual([
        '/api/probe?kept=1', '/ws?kept=1', '/api/probe?kept=1', '/ws?kept=1',
      ]);
      const proof = buildPlatformUserProof(route.handle, OWNER, PLATFORM_SECRET);
      for (const request of requests) {
        expect.soft(request.headers['x-platform-user-id']).toBe(OWNER);
        expect.soft(request.headers['x-platform-verified']).toBe(proof);
        expect.soft(request.headers.authorization).toBe(`Bearer ${buildPlatformVerificationToken(route.handle, PLATFORM_SECRET)}`);
      }
      expect.soft(httpHosts).toContain(PRIVATE_ALIAS);
      expect.soft(tcp.hosts).toContain(PRIVATE_ALIAS);
      expect.soft((await http(`${explicit}/api/redirect`, owner)).status).toBe(302);
      const shellResponse = await http(`${explicit}/settings`, 'synthetic-clerk-session');
      expect.soft(await shellResponse.text()).toBe('registered shell response');
      expect.soft(shellResponse.headers.getSetCookie()).toContainEqual(expect.stringContaining(`matrix_shell_route=${route.handle}`));
      const sessionResponse = await http(`${explicit}/api/apps/demo/session`, owner);
      expect.soft(sessionResponse.headers.getSetCookie()).toContainEqual(expect.stringContaining(`Path=${explicit}/apps/demo/`));
      expect.soft(await ws(`${explicit}/ws`, 'synthetic-clerk-session')).toBe('registered gateway socket');
      const websocketAuth = await http(`${explicit}/api/auth/ws-token`, owner);
      expect.soft(websocketAuth.status).toBe(200);
      const issued = await websocketAuth.json() as { token: string };
      expect.soft(await ws(`${explicit}/ws?kept=1&token=${encodeURIComponent(issued.token)}`)).toBe('registered gateway socket');
      expect.soft(requests.at(-1)?.path).toBe('/ws?kept=1');

      const hmrPrefix = `${explicit}/~runtime/primary/_next`;
      for (const path of [`${hmrPrefix}/hmr`, `${hmrPrefix}/webpack-hmr`]) {
        expect.soft(await ws(`${path}?id=fixture&runtime=primary`, 'synthetic-clerk-session'))
          .toBe('registered shell socket');
        expect.soft(requests.at(-1)?.path).toBe(`${path}?id=fixture`);
      }
      expect.soft(await ws(`${hmrPrefix}/hmr-extra`, owner)).toBe('registered gateway socket');
      expect.soft(requests.at(-1)?.path).toBe('/_next/hmr-extra');

      const attempts = requests.length;
      expect.soft(await ws(`${hmrPrefix}/hmr`)).toBe(401);
      expect.soft(await ws(`${hmrPrefix}/hmr`, await token('user_wrong'))).toBe(401);
      expect.soft(await ws(`${explicit}/~runtime/other-slot/_next/hmr`, owner)).toBe(404);
      const deny = async (prefix: string, jwt: string) => {
        expect.soft((await http(`${prefix}/api/probe`, jwt)).status).toBeGreaterThanOrEqual(400);
        const result = await ws(`${prefix}/ws`, jwt);
        expect.soft(typeof result === 'number' && result >= 400).toBe(true);
      };
      await deny(explicit, await token('user_wrong'));
      await deny('/vm/other-handle', owner);
      await deny(`${explicit}/~runtime/other-slot`, owner);
      await deny(explicit, await token(OWNER, route.handle, 'other-slot'));
      const unauthenticated = await app.request(`https://app.matrix-os.com${explicit}/api/probe`, { headers: { host: 'app.matrix-os.com' } });
      expect.soft(unauthenticated.status).toBe(401);
      await insertUserMachine(other, {
        machineId: '22222222-2222-4222-8222-222222222222',
        clerkUserId: OWNER, handle: 'unregistered-vps', runtimeSlot: 'other-slot', status: 'running',
        publicIPv4: null, imageVersion: 'dev', serverType: 'cpx22', provisionedAt: '2026-07-16T00:00:00.000Z',
      });
      await deny('/vm/unregistered-vps/~runtime/other-slot', owner);

      tcp.available = false;
      expect.soft((await http(`${explicit}/api/probe`, owner)).status).toBe(502);
      expect.soft(await ws(`${explicit}/ws`, owner)).toBe(502);
      tcp.available = true;

      entitlementStatus = 'missing';
      expect.soft((await http(`${explicit}/api/probe`, owner)).status).toBe(402);
      expect.soft((await http(`${explicit}/api/auth/ws-token`, owner)).status).toBe(402);
      expect.soft(await ws(`${explicit}/ws`, owner)).toBe(403);
      expect.soft(await ws(`${hmrPrefix}/hmr`, owner)).toBe(403);
      entitlementStatus = 'active';

      for (const change of [{ container_id: 'matrixos-stale' }, { container_id: null }, { status: 'stopped' }]) {
        await other.executor.updateTable('containers').set(change).where('handle', '=', route.handle).execute();
        await deny('', owner);
        const row = await getContainer(db, route.handle);
        expect.soft(row?.containerId).toBe('container_id' in change ? change.container_id : null);
        expect.soft(row?.status).toBe('status' in change ? change.status : 'running');
      }
      await other.executor.updateTable('containers').set({ container_id: route.containerId, status: 'running' })
        .where('handle', '=', route.handle).execute();
      for (const change of [
        { container_id: `devstack:demo-b:${OWNER}` },
        { container_id: 'devstack:demo-a:user_wrong' },
        { handle: 'other-owner-handle', container_id: `devstack:demo-a:${OWNER}` },
        { handle: route.handle, status: 'suspended' },
      ]) {
        await other.executor.updateTable('users').set(change).where('id', '=', registered.userId).execute();
        await deny('', owner);
      }
      expect.soft((await db.executor.selectFrom('containers').selectAll().executeTakeFirstOrThrow()).last_active)
        .toEqual(before.last_active);
      await other.executor.deleteFrom('containers').where('handle', '=', route.handle).execute();
      await deny(explicit, owner);
      expect.soft(requests).toHaveLength(attempts);
      expect.soft(orchestrator.start).not.toHaveBeenCalled();
      expect.soft(docker.getContainer).not.toHaveBeenCalled();
    } finally {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      for (const socket of shellSockets.clients) socket.terminate();
      shellSockets.close();
      upstream.closeAllConnections();
      shell.closeAllConnections();
      platform.closeAllConnections();
      await Promise.all([
        dispatcher.destroy(),
        new Promise<void>(resolve => upstream.close(() => resolve())),
        new Promise<void>(resolve => shell.close(() => resolve())),
        new Promise<void>(resolve => platform.close(() => resolve())),
      ]);
      tcp.hosts.length = 0;
      tcp.available = true;
    }
  });
});
