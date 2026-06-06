import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createHmac } from 'node:crypto';
import {
  type PlatformDB,
  getContainerByClerkId,
  getPlatformUserByClerkId,
  insertContainer,
  insertUserMachine,
  updateUserMachine,
} from '../../packages/platform/src/db.js';
import { createDisabledOrchestrator, createOrchestrator } from '../../packages/platform/src/orchestrator.js';
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

  it('records HTTP metrics when a downstream handler throws', async () => {
    metricsRegistry.resetMetrics();
    const { docker } = createMockDocker();
    const orchestrator = createOrchestrator({ db, docker: docker as any });
    const errorApp = createApp({ db, orchestrator, platformSecret });
    errorApp.get('/boom', () => {
      throw new Error('boom');
    });

    const res = await errorApp.request('/boom', { headers: adminHeaders }).catch((err: unknown) => {
      expect(err).toBeInstanceOf(Error);
      return null;
    });
    if (res) {
      expect(res.status).toBe(500);
    }

    const output = await metricsRegistry.metrics();
    expect(output).toContain('platform_http_requests_total{method="GET",path="/:path",status="500"} 1');
  });

  it('POST /containers/provision creates a container', async () => {
    const res = await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ handle: 'alice', clerkUserId: 'clerk_1', displayName: 'Alice A', email: 'alice@example.com' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.handle).toBe('alice');
    expect(body.status).toBe('running');

    const user = await getPlatformUserByClerkId(db, 'clerk_1');
    expect(user).toMatchObject({
      clerkId: 'clerk_1',
      handle: 'alice',
      displayName: 'Alice A',
      email: 'alice@example.com',
      status: 'active',
    });
    expect(user?.containerId).toBe('legacy:alice');
  });

  it('POST /users/sync creates a platform user without provisioning a runtime', async () => {
    const res = await app.request('/users/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({
        handle: 'trinity',
        clerkUserId: 'clerk_trinity',
        displayName: 'Trinity',
        email: 'trinity@example.com',
      }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      clerkUserId: 'clerk_trinity',
      handle: 'trinity',
      status: 'active',
    });
    await expect(getPlatformUserByClerkId(db, 'clerk_trinity')).resolves.toMatchObject({
      clerkId: 'clerk_trinity',
      handle: 'trinity',
      displayName: 'Trinity',
      email: 'trinity@example.com',
      containerId: 'clerk:clerk_trinity',
    });
    await expect(getContainerByClerkId(db, 'clerk_trinity')).resolves.toBeUndefined();
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
      runtimeSlot: 'primary',
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      status: 'provisioning',
      etaSeconds: 90,
    });
    expect(customerVpsService.provision).toHaveBeenCalledWith({ handle: 'alice', clerkUserId: 'clerk_1', runtimeSlot: 'primary' });
    expect(provisionSpy).not.toHaveBeenCalled();
    await expect(getPlatformUserByClerkId(db, 'clerk_1')).resolves.toMatchObject({
      clerkId: 'clerk_1',
      handle: 'alice',
      displayName: 'Alice',
      email: 'alice@matrix-os.local',
      containerId: 'vps:9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      status: 'active',
    });
  });

  it('POST /containers/provision allows operator provisioning when user entitlement denies access', async () => {
    process.env.MATRIX_PAID_BETA_ENTITLEMENT_STATUS = 'expired';
    const { docker } = createMockDocker();
    const orchestrator = createOrchestrator({ db, docker: docker as any });
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
      body: JSON.stringify({ handle: 'alice', clerkUserId: 'clerk_1' }),
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      runtime: 'customer_vps',
      handle: 'alice',
      clerkUserId: 'clerk_1',
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      status: 'provisioning',
    });
    expect(customerVpsService.provision).toHaveBeenCalledWith({ handle: 'alice', clerkUserId: 'clerk_1', runtimeSlot: 'primary' });
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

  it('serves the admin dashboard when the legacy proxy usage service is absent', async () => {
    const cloudApp = createApp({
      db,
      orchestrator: createDisabledOrchestrator({ db }),
      platformSecret,
      env: {
        PLATFORM_RUNTIME_MODE: 'cloud_run',
        CUSTOMER_VPS_ENABLED: 'true',
      } as NodeJS.ProcessEnv,
    });
    const originalFetch = globalThis.fetch;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    try {
      const res = await cloudApp.request('/admin/dashboard', { headers: adminHeaders });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        summary: {
          total: 0,
          running: 0,
          stopped: 0,
        },
        containers: [],
        stoppedContainers: [],
        usageSummary: null,
      });
      expect(globalThis.fetch).toHaveBeenCalledWith('http://proxy:8080/usage/summary', {
        signal: expect.any(AbortSignal),
      });
    } finally {
      globalThis.fetch = originalFetch;
      warnSpy.mockRestore();
    }
  });

  it('GET /metrics serves fresher runtime probes collected by /vps/fleet', async () => {
    metricsRegistry.resetMetrics();
    const machine = {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      clerkUserId: 'clerk_1',
      handle: 'alice',
      publicIPv4: '203.0.113.10',
      publicIPv6: null,
      status: 'running' as const,
      imageVersion: 'v2026.05.24-1',
      provisionedAt: '2026-05-24T10:00:00.000Z',
      lastSeenAt: '2026-05-24T10:00:00.000Z',
      deletedAt: null,
      failureCode: null,
      failureAt: null,
    };
    await insertUserMachine(db, machine);
    const { docker } = createMockDocker();
    const orchestrator = createOrchestrator({ db, docker: docker as any });
    const customerVpsService = {
      listAllMachines: vi.fn().mockResolvedValue([machine]),
    };
    const metricsApp = createApp({
      db,
      orchestrator,
      platformSecret,
      customerVpsService: customerVpsService as any,
    });
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createSystemInfoResponse())
      .mockResolvedValueOnce(new Response('unhealthy', { status: 503 }));
    globalThis.fetch = fetchMock;
    try {
      const firstMetrics = await metricsApp.request('/metrics');
      expect(firstMetrics.status).toBe(200);
      expect(await firstMetrics.text()).toContain('matrix_vps_healthy{handle="alice"} 1');

      const fleet = await metricsApp.request('/vps/fleet', {
        headers: adminHeaders,
      });
      expect(fleet.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const secondMetrics = await metricsApp.request('/metrics');
      expect(secondMetrics.status).toBe(200);
      expect(await secondMetrics.text()).toContain('matrix_vps_healthy{handle="alice"} 0');
      expect(fetchMock).toHaveBeenCalledTimes(2);
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
      expect(fetchMock).toHaveBeenCalledTimes(3);

      secondKeyAliceProbe.resolve(createSystemInfoResponse());
      secondKeyBobProbe.resolve(createSystemInfoResponse());
      expect((await secondRequest).status).toBe(200);
      expect((await thirdRequest).status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('GET /metrics does not overwrite fresher /vps/fleet runtime cache with an older probe', async () => {
    metricsRegistry.resetMetrics();
    const machine = {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      clerkUserId: 'clerk_1',
      handle: 'alice',
      publicIPv4: '203.0.113.10',
      publicIPv6: null,
      status: 'running' as const,
      imageVersion: 'v2026.05.24-1',
      provisionedAt: '2026-05-24T10:00:00.000Z',
      lastSeenAt: '2026-05-24T10:00:00.000Z',
      deletedAt: null,
      failureCode: null,
      failureAt: null,
    };
    await insertUserMachine(db, machine);
    const { docker } = createMockDocker();
    const orchestrator = createOrchestrator({ db, docker: docker as any });
    const customerVpsService = {
      listAllMachines: vi.fn().mockResolvedValue([machine]),
    };
    const metricsApp = createApp({
      db,
      orchestrator,
      platformSecret,
      customerVpsService: customerVpsService as any,
    });
    const olderMetricsProbe = createDeferred<Response>();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn()
      .mockReturnValueOnce(olderMetricsProbe.promise)
      .mockResolvedValueOnce(new Response('unhealthy', { status: 503 }));
    globalThis.fetch = fetchMock;
    try {
      const metricsRequest = metricsApp.request('/metrics');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      const fleet = await metricsApp.request('/vps/fleet', {
        headers: adminHeaders,
      });
      expect(fleet.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      olderMetricsProbe.resolve(createSystemInfoResponse());
      const metrics = await metricsRequest;
      expect(metrics.status).toBe(200);
      expect(await metrics.text()).toContain('matrix_vps_healthy{handle="alice"} 0');

      const nextMetrics = await metricsApp.request('/metrics');
      expect(await nextMetrics.text()).toContain('matrix_vps_healthy{handle="alice"} 0');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('GET /metrics does not overwrite changed-fleet runtime cache with an older probe', async () => {
    metricsRegistry.resetMetrics();
    const alice = {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      clerkUserId: 'clerk_1',
      handle: 'alice',
      publicIPv4: '203.0.113.10',
      publicIPv6: null,
      status: 'running' as const,
      imageVersion: 'v2026.05.24-1',
      provisionedAt: '2026-05-24T10:00:00.000Z',
      lastSeenAt: '2026-05-24T10:00:00.000Z',
      deletedAt: null,
      failureCode: null,
      failureAt: null,
    };
    const bob = {
      machineId: 'f973bb98-2538-4f9f-a10d-1be5920a7bf7',
      clerkUserId: 'clerk_2',
      handle: 'bob',
      publicIPv4: '203.0.113.11',
      publicIPv6: null,
      status: 'running' as const,
      imageVersion: 'v2026.05.24-1',
      provisionedAt: '2026-05-24T10:01:00.000Z',
      lastSeenAt: '2026-05-24T10:01:00.000Z',
      deletedAt: null,
      failureCode: null,
      failureAt: null,
    };
    await insertUserMachine(db, alice);
    await insertUserMachine(db, bob);
    const { docker } = createMockDocker();
    const orchestrator = createOrchestrator({ db, docker: docker as any });
    const customerVpsService = {
      listAllMachines: vi.fn().mockResolvedValue([alice]),
    };
    const metricsApp = createApp({
      db,
      orchestrator,
      platformSecret,
      customerVpsService: customerVpsService as any,
    });
    const olderAliceProbe = createDeferred<Response>();
    const olderBobProbe = createDeferred<Response>();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn()
      .mockReturnValueOnce(olderAliceProbe.promise)
      .mockReturnValueOnce(olderBobProbe.promise)
      .mockResolvedValueOnce(new Response('unhealthy', { status: 503 }));
    globalThis.fetch = fetchMock;
    try {
      const metricsRequest = metricsApp.request('/metrics');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

      await updateUserMachine(db, bob.machineId, {
        status: 'deleted',
        deletedAt: '2026-05-24T10:02:00.000Z',
      });
      const fleet = await metricsApp.request('/vps/fleet', {
        headers: adminHeaders,
      });
      expect(fleet.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      olderAliceProbe.resolve(createSystemInfoResponse());
      olderBobProbe.resolve(createSystemInfoResponse());
      expect((await metricsRequest).status).toBe(200);

      const nextMetrics = await metricsApp.request('/metrics');
      const text = await nextMetrics.text();
      expect(text).toContain('matrix_vps_healthy{handle="alice"} 0');
      expect(text).not.toContain('matrix_vps_healthy{handle="bob"}');
      expect(fetchMock).toHaveBeenCalledTimes(3);
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

  it('POST /containers/provision returns structured unsupported response when legacy orchestration is disabled', async () => {
    const cloudApp = createApp({
      db,
      orchestrator: createDisabledOrchestrator({ db }),
      platformSecret,
      env: {
        PLATFORM_RUNTIME_MODE: 'cloud_run',
        CUSTOMER_VPS_ENABLED: 'true',
      } as NodeJS.ProcessEnv,
    });

    const res = await cloudApp.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders },
      body: JSON.stringify({ handle: 'alice', clerkUserId: 'c1' }),
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Not supported in this runtime mode' });
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

  it.each([
    ['POST', '/containers/alice/start', adminHeaders],
    ['POST', '/containers/alice/stop', adminHeaders],
    ['POST', '/containers/alice/upgrade', adminHeaders],
    [
      'POST',
      '/containers/alice/self-upgrade',
      { authorization: `Bearer ${createHmac('sha256', platformSecret).update('alice').digest('hex')}` },
    ],
    ['POST', '/containers/rolling-restart', adminHeaders],
    ['DELETE', '/containers/alice', adminHeaders],
  ])('%s %s returns structured unsupported response in cloud mode', async (method, path, headers) => {
    const cloudApp = createApp({
      db,
      orchestrator: createDisabledOrchestrator({ db }),
      platformSecret,
      env: {
        PLATFORM_RUNTIME_MODE: 'cloud_run',
        CUSTOMER_VPS_ENABLED: 'true',
      } as NodeJS.ProcessEnv,
    });

    const res = await cloudApp.request(path, {
      method,
      headers,
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Not supported in this runtime mode' });
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
