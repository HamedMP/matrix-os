import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { registerPlatformWebSocketUpgradeHandler } from '../../packages/platform/src/platform-websocket-upgrade.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { createMetalWakeRig, HANDLE, INGRESS_TOKEN, OWNER, type MetalWakeRig } from './metal-wake-rig.js';

/**
 * Spec 2691 / ENG-520, Task P3: WebSocket upgrades wake a sleeping metal VM
 * before relaying to the host ingress over verified TLS. Ported from
 * feat/2691-container-register tests/platform/container-websocket.test.ts.
 */

type Outcome =
  | { kind: 'open'; ws: WebSocket; protocolHeader: string | undefined }
  | { kind: 'refused'; status: number; retryAfter: string | undefined; body: string };

describe('WebSocket upgrades to a metal runtime', () => {
  let db: PlatformDB;
  let rig: MetalWakeRig;
  let server: Server;
  let origin: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    rig = await createMetalWakeRig(db);
    server = createServer((_req, res) => { res.writeHead(404); res.end(); });
    const decision = { runtimeProxyAllowed: true } as never;
    registerPlatformWebSocketUpgradeHandler({
      server, app: { capturePlatformEvent: vi.fn() }, db,
      clerkAuth: createClerkAuth({ verifyToken: async (token) => ({ sub: token }) }),
      env: {}, platformSecret: 'platform-secret-123', platformJwtSecret: 'jwt-secret-'.padEnd(40, 'z'),
      legacyContainerRoutingEnabled: false, codeServerPort: 8080,
      getRuntimeEntitlementDecision: () => decision, getRuntimeEntitlementDecisionForUser: async () => decision,
      substrates: rig.substrates,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rig.close();
    await destroyTestPlatformDb(db);
  });

  function connect(path: string, userId = OWNER): Promise<Outcome> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${origin}${path}`, {
        headers: { host: 'app.matrix-os.com', authorization: `Bearer ${userId}`, 'x-matrix-host-auth': 'client-forged' },
      });
      sockets.push(ws);
      ws.once('upgrade', (res) => {
        ws.once('open', () => resolve({ kind: 'open', ws, protocolHeader: res.headers['x-matrix-host-auth'] as string | undefined }));
      });
      ws.once('unexpected-response', (_req, res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
        res.on('end', () => resolve({
          kind: 'refused', status: res.statusCode ?? 0, retryAfter: res.headers['retry-after'] as string | undefined, body,
        }));
      });
      ws.once('error', (error) => reject(error));
    });
  }

  function roundTrip(ws: WebSocket, message: string): Promise<string> {
    return new Promise((resolve) => {
      ws.once('message', (data) => resolve(data.toString()));
      ws.send(message);
    });
  }

  it.each([
    ['explicit /vm route', '/vm/alice/ws/terminal?x=1'],
    ['session route', '/ws/terminal?x=1'],
  ])('WebSocket upgrade to a suspended VM waits for resume, then upgrades (%s)', async (_label, path) => {
    rig.resume = { kind: 'state', state: 'running', delayMs: 200 };

    const outcome = await connect(path);

    expect(outcome.kind).toBe('open');
    if (outcome.kind !== 'open') return;
    expect(await roundTrip(outcome.ws, 'hello')).toBe('echo:hello');
    expect(outcome.protocolHeader).toBeUndefined();
    expect(rig.resumeCalls()).toHaveLength(1);
    expect((await rig.machine())?.status).toBe('running');
    const upgrade = rig.ingress.requests.find((req) => req.upgrade)!;
    expect(upgrade.path).toBe('/ws/terminal?x=1');
    expect(upgrade.headers.host).toBe(`${HANDLE}.matrix-os.com`);
    expect(upgrade.headers['x-matrix-host-auth']).toBe(INGRESS_TOKEN);
  });

  it('an upgrade to a VM the host put to sleep wakes it and is retried once before completing', async () => {
    await db.executor.updateTable('user_machines').set({ status: 'running' }).where('machine_id', '=', rig.machineId).execute();
    rig.ingress.asleepResponses = 1;

    const outcome = await connect('/vm/alice/ws/terminal');

    expect(outcome.kind).toBe('open');
    if (outcome.kind !== 'open') return;
    expect(await roundTrip(outcome.ws, 'again')).toBe('echo:again');
    expect(rig.resumeCalls()).toHaveLength(1);
    expect(rig.ingress.requests.filter((req) => req.upgrade)).toHaveLength(2);
  });

  it('refuses with waking, not runtime_asleep, when the VM stays asleep after the retry', async () => {
    await db.executor.updateTable('user_machines').set({ status: 'running' }).where('machine_id', '=', rig.machineId).execute();
    rig.ingress.asleepResponses = 2;

    const outcome = await connect('/vm/alice/ws/terminal');

    expect(outcome).toMatchObject({ kind: 'refused', status: 503, retryAfter: '3' });
    if (outcome.kind !== 'refused') return;
    expect(outcome.body).not.toContain('runtime_asleep');
    expect(JSON.parse(outcome.body)).toEqual({ error: 'Matrix computer not ready', runtimeState: 'waking' });
  });

  it('passes a VM-originated 503 runtime_asleep handshake through without the ingress marker, never retrying', async () => {
    await db.executor.updateTable('user_machines').set({ status: 'running' }).where('machine_id', '=', rig.machineId).execute();
    rig.ingress.vmAsleepBodyResponses = 1;

    const outcome = await connect('/vm/alice/ws/terminal');

    expect(outcome).toMatchObject({ kind: 'refused', status: 503 });
    expect(rig.ingress.requests.filter((req) => req.upgrade)).toHaveLength(1);
    expect(rig.resumeCalls()).toHaveLength(0);
    expect((await rig.machine())?.status).toBe('running');
  });

  it('concurrent upgrades share one resume', async () => {
    rig.resume = { kind: 'state', state: 'running', delayMs: 200 };
    const outcomes = await Promise.all([connect('/vm/alice/ws'), connect('/ws'), connect('/vm/alice/ws/terminal')]);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['open', 'open', 'open']);
    expect(rig.resumeCalls()).toHaveLength(1);
  });

  it('refuses with 503 waking and Retry-After 3 while the resume is still running, without relaying', async () => {
    rig.resume = { kind: 'state', state: 'starting' };

    const outcome = await connect('/vm/alice/ws/terminal');

    expect(outcome).toMatchObject({ kind: 'refused', status: 503, retryAfter: '3' });
    if (outcome.kind !== 'refused') return;
    expect(JSON.parse(outcome.body)).toEqual({ error: 'Matrix computer not ready', runtimeState: 'waking' });
    expect(rig.ingress.requests).toEqual([]);
  });

  it('does not wake for another signed-in user', async () => {
    const outcome = await connect('/vm/alice/ws', 'user_stranger');
    expect(outcome).toMatchObject({ kind: 'refused', status: 404 });
    expect(rig.hostd.requests).toEqual([]);
  });
});
