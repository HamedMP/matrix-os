import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createHmac } from 'node:crypto';
import { type PlatformDB, insertContainer, insertUserMachine } from '../../packages/platform/src/db.js';
import { createOrchestrator } from '../../packages/platform/src/orchestrator.js';
import { createApp } from '../../packages/platform/src/main.js';
import { metricsRegistry } from '../../packages/platform/src/metrics.js';

function createMockDocker() {
  const mockContainer = {
    id: 'mock-ctr-id',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };

  return {
    docker: {
      listNetworks: vi.fn().mockResolvedValue([{ Name: 'matrixos-net' }]),
      createNetwork: vi.fn().mockResolvedValue({}),
      createContainer: vi.fn().mockResolvedValue(mockContainer),
      getContainer: vi.fn().mockReturnValue(mockContainer),
      pull: vi.fn().mockResolvedValue(undefined),
    },
    mockContainer,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createSystemInfoResponse() {
  return new Response(
    JSON.stringify({
      resources: {
        cpuCount: 2,
        loadAverage: [0.25],
        memoryTotalBytes: 4 * 1024 * 1024 * 1024,
        memoryFreeBytes: 1024 * 1024 * 1024,
        diskTotalBytes: 40 * 1024 * 1024 * 1024,
        diskFreeBytes: 30 * 1024 * 1024 * 1024,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('platform/api', () => {
  let db: PlatformDB;
  let app: ReturnType<typeof createApp>;
  const platformSecret = 'platform-secret-123';
  const adminHeaders = { authorization: `Bearer ${platformSecret}` };

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    const { docker } = createMockDocker();
    const orchestrator = createOrchestrator({ db, docker: docker as any });
    app = createApp({ db, orchestrator, platformSecret });
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  it('GET /health returns ok', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('POST /containers/provision creates a container', async () => {
    const res = await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ handle: 'alice', clerkUserId: 'clerk_1' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.handle).toBe('alice');
    expect(body.status).toBe('running');
  });

  it('POST /containers/provision delegates onboarding to one customer VPS when configured', async () => {
    const { docker } = createMockDocker();
    const orchestrator = createOrchestrator({ db, docker: docker as any });
    const provisionSpy = vi.spyOn(orchestrator, 'provision');
    const customerVpsService = {
      provision: vi.fn().mockResolvedValue({
        machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
        status: 'provisioning',
        etaSeconds: 90,
      }),
    };
    const vpsApp = createApp({
      db,
      orchestrator,
      platformSecret,
      customerVpsService: customerVpsService as any,
    });

    const res = await vpsApp.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ handle: 'alice', clerkUserId: 'clerk_1', displayName: 'Alice' }),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      runtime: 'customer_vps',
      handle: 'alice',
      clerkUserId: 'clerk_1',
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      status: 'provisioning',
      etaSeconds: 90,
    });
    expect(customerVpsService.provision).toHaveBeenCalledWith({ handle: 'alice', clerkUserId: 'clerk_1' });
    expect(provisionSpy).not.toHaveBeenCalled();
  });

  it('GET /metrics reuses cached VPS runtime probes between scrapes', async () => {
    metricsRegistry.resetMetrics();
    await insertUserMachine(db, {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      clerkUserId: 'clerk_1',
      handle: 'alice',
      publicIPv4: '203.0.113.10',
      status: 'running',
      imageVersion: 'v2026.05.24-1',
      provisionedAt: '2026-05-24T10:00:00.000Z',
      lastSeenAt: '2026-05-24T10:00:00.000Z',
    });
    const { docker } = createMockDocker();
    const orchestrator = createOrchestrator({ db, docker: docker as any });
    const customerVpsService = {};
    const metricsApp = createApp({
      db,
      orchestrator,
      platformSecret,
      customerVpsService: customerVpsService as any,
    });
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(
      createSystemInfoResponse(),
    );
    globalThis.fetch = fetchMock;
    try {
      const first = await metricsApp.request('/metrics');
      const second = await metricsApp.request('/metrics');

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await second.text()).toContain('matrix_vps_healthy{handle="alice"} 1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('GET /metrics keeps newer pending VPS runtime probes when an older probe settles', async () => {
    metricsRegistry.resetMetrics();
    await insertUserMachine(db, {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      clerkUserId: 'clerk_1',
      handle: 'alice',
      publicIPv4: '203.0.113.10',
      status: 'running',
      imageVersion: 'v2026.05.24-1',
      provisionedAt: '2026-05-24T10:00:00.000Z',
      lastSeenAt: '2026-05-24T10:00:00.000Z',
    });
    const { docker } = createMockDocker();
    const orchestrator = createOrchestrator({ db, docker: docker as any });
    const customerVpsService = {};
    const metricsApp = createApp({
      db,
      orchestrator,
      platformSecret,
      customerVpsService: customerVpsService as any,
    });
    const firstProbe = createDeferred<Response>();
    const secondKeyAliceProbe = createDeferred<Response>();
    const secondKeyBobProbe = createDeferred<Response>();
    const deferredProbes = [firstProbe, secondKeyAliceProbe, secondKeyBobProbe];
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(() => {
      const deferred = deferredProbes[fetchMock.mock.calls.length - 1];
      return deferred?.promise ?? Promise.reject(new Error('unexpected duplicate runtime probe'));
    });
    globalThis.fetch = fetchMock;
    try {
      const firstRequest = metricsApp.request('/metrics');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      await insertUserMachine(db, {
        machineId: 'f973bb98-2538-4f9f-a10d-1be5920a7bf7',
        clerkUserId: 'clerk_2',
        handle: 'bob',
        publicIPv4: '203.0.113.11',
        status: 'running',
        imageVersion: 'v2026.05.24-1',
        provisionedAt: '2026-05-24T10:01:00.000Z',
        lastSeenAt: '2026-05-24T10:01:00.000Z',
      });
      const secondRequest = metricsApp.request('/metrics');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

      firstProbe.resolve(createSystemInfoResponse());
      expect((await firstRequest).status).toBe(200);

      const thirdRequest = metricsApp.request('/metrics');
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(fetchMock).toHaveBeenCalledTimes(3);

      secondKeyAliceProbe.resolve(createSystemInfoResponse());
      secondKeyBobProbe.resolve(createSystemInfoResponse());
      expect((await secondRequest).status).toBe(200);
      expect((await thirdRequest).status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('POST /containers/provision rejects missing fields', async () => {
    const res = await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ handle: 'alice' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /containers/provision rejects invalid handles', async () => {
    const res = await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ handle: '../../etc', clerkUserId: 'clerk_1' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /containers/provision rejects invalid runtime types for clerkUserId', async () => {
    const res = await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ handle: 'alice', clerkUserId: true }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Validation error' });
  });

  it('POST /containers/provision returns a generic duplicate error', async () => {
    await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ handle: 'alice', clerkUserId: 'c1' }),
    });

    const res = await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ handle: 'alice', clerkUserId: 'c2' }),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Container already exists' });
  });

  it('fails closed when admin routes are not configured with a secret', async () => {
    const { docker } = createMockDocker();
    const orchestrator = createOrchestrator({ db, docker: docker as any });
    const noSecretApp = createApp({ db, orchestrator, platformSecret: '' });

    const res = await noSecretApp.request('/containers');
    expect(res.status).toBe(503);
  });

  it('GET /containers lists all containers', async () => {
    await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ handle: 'alice', clerkUserId: 'c1' }),
    });
    await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ handle: 'bob', clerkUserId: 'c2' }),
    });

    const res = await app.request('/containers', { headers: adminHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  it('GET /containers/:handle returns container info', async () => {
    await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ handle: 'alice', clerkUserId: 'c1' }),
    });

    const res = await app.request('/containers/alice', { headers: adminHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handle).toBe('alice');
  });

  it('GET /containers/:handle returns 404 for unknown handle', async () => {
    const res = await app.request('/containers/ghost', { headers: adminHeaders });
    expect(res.status).toBe(404);
  });

  it('POST /containers/:handle/stop stops a container', async () => {
    await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ handle: 'alice', clerkUserId: 'c1' }),
    });

    const res = await app.request('/containers/alice/stop', { method: 'POST', headers: adminHeaders });
    expect(res.status).toBe(200);

    const info = await app.request('/containers/alice', { headers: adminHeaders });
    const body = await info.json();
    expect(body.status).toBe('stopped');
  });

  it('POST /containers/:handle/start does not leak raw orchestrator errors', async () => {
    const { docker } = createMockDocker();
    const orchestrator = createOrchestrator({ db, docker: docker as any });
    vi.spyOn(orchestrator, 'start').mockRejectedValueOnce(new Error('docker exploded'));
    const errorApp = createApp({ db, orchestrator, platformSecret });

    const res = await errorApp.request('/containers/alice/start', {
      method: 'POST',
      headers: adminHeaders,
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Failed to start container' });
  });

  it('POST /social/send/:handle rejects invalid runtime body types', async () => {
    const res = await app.request('/social/send/alice', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ text: null, from: { handle: 'alice' } }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Validation error' });
  });

  it.each([
    ['POST', '/containers/Bad_Handle/start'],
    ['POST', '/containers/Bad_Handle/stop'],
    ['POST', '/containers/Bad_Handle/upgrade'],
    ['POST', '/containers/Bad_Handle/self-upgrade'],
    ['DELETE', '/containers/Bad_Handle'],
  ])('%s %s rejects invalid handles before orchestrator access', async (method, path) => {
    const res = await app.request(path, {
      method,
      headers: adminHeaders,
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid handle' });
  });

  it('POST /containers/:handle/self-upgrade rejects invalid bearer tokens regardless of length', async () => {
    await insertContainer(db, {
      handle: 'alice',
      clerkUserId: 'c1',
      port: 5001,
      shellPort: 6001,
      status: 'running',
    });

    const res = await app.request('/containers/alice/self-upgrade', {
      method: 'POST',
      headers: { authorization: 'Bearer short' },
    });

    expect(res.status).toBe(401);
  });

  it('POST /containers/:handle/self-upgrade accepts the derived per-handle bearer token', async () => {
    await insertContainer(db, {
      handle: 'alice',
      clerkUserId: 'c1',
      port: 5001,
      shellPort: 6001,
      status: 'running',
    });
    const expected = createHmac('sha256', platformSecret).update('alice').digest('hex');

    const res = await app.request('/containers/alice/self-upgrade', {
      method: 'POST',
      headers: { authorization: `Bearer ${expected}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ handle: 'alice' });
  });

  it('POST /containers/rolling-restart upgrades running containers', async () => {
    await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ handle: 'alice', clerkUserId: 'c1' }),
    });
    await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ handle: 'bob', clerkUserId: 'c2' }),
    });

    const res = await app.request('/containers/rolling-restart', { method: 'POST', headers: adminHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.succeeded).toBe(2);
    expect(body.failed).toBe(0);
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('DELETE /containers/:handle destroys a container', async () => {
    await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ handle: 'alice', clerkUserId: 'c1' }),
    });

    const res = await app.request('/containers/alice', { method: 'DELETE', headers: adminHeaders });
    expect(res.status).toBe(200);

    const info = await app.request('/containers/alice', { headers: adminHeaders });
    expect(info.status).toBe(404);
  });
});
