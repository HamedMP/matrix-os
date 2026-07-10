import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { type PlatformDB } from '../../packages/platform/src/db.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { createCustomerVpsRoutes } from '../../packages/platform/src/customer-vps-routes.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

describe('platform/customer-vps-routes', () => {
  let db: PlatformDB;
  const platformSecret = 'platform-secret';

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
  });

  function createApp() {
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_PORT: '9000',
        PLATFORM_SECRET: platformSecret,
        HETZNER_API_TOKEN: 'token',
        S3_ACCESS_KEY_ID: 'r2-access-key',
        S3_SECRET_ACCESS_KEY: 'r2-secret-key',
        S3_ENDPOINT: 'https://r2.example',
        R2_BUCKET: 'matrixos-sync',
      }),
      hetzner: createMockHetznerClient(),
      systemStore: createMockCustomerVpsSystemStore(),
      tokenFactory: () => ({
        token: 'registration-token',
        hash: hashRegistrationToken('registration-token'),
        expiresAt: '2099-01-01T00:00:00.000Z',
      }),
      machineIdFactory: () => '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      postgresPasswordFactory: () => 'postgres-secret',
      now: () => new Date('2026-04-26T12:00:00.000Z'),
    });
    const app = new Hono();
    app.route('/vps', createCustomerVpsRoutes({ service, platformSecret }));
    return app;
  }

  it('requires the platform bearer token for provision and status routes', async () => {
    const app = createApp();
    const provision = await app.request('/vps/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clerkUserId: 'user_123', handle: 'alice' }),
    });
    const status = await app.request('/vps/9f05824c-8d0a-4d83-9cb4-b312d43ff112/status');

    expect(provision.status).toBe(401);
    expect(status.status).toBe(401);
  });

  it('protects and validates the preview provision route contract', async () => {
    const provision = vi.fn();
    const provisionPreview = vi.fn().mockResolvedValue({
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      status: 'provisioning',
      etaSeconds: 90,
    });
    const service = {
      provision,
      provisionPreview,
    } as unknown as Parameters<typeof createCustomerVpsRoutes>[0]['service'];
    const app = new Hono();
    app.route('/vps', createCustomerVpsRoutes({ service, platformSecret }));

    const unauthorized = await app.request('/vps/preview/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clerkUserId: 'user_123', handle: 'pr-897', runtimeSlot: 'pr-897' }),
    });
    expect(unauthorized.status).toBe(401);

    for (const body of [
      { clerkUserId: 'user_123', handle: 'preview-897', runtimeSlot: 'preview-897' },
      { clerkUserId: 'user_123', handle: 'pr-897', runtimeSlot: 'pr-896' },
      { clerkUserId: 'user_123', handle: 'pr-897', runtimeSlot: 'pr-897', serverType: 'cpx52' },
    ]) {
      const invalid = await app.request('/vps/preview/provision', {
        method: 'POST',
        headers: { authorization: `Bearer ${platformSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: 'Invalid request' });
    }

    const accepted = await app.request('/vps/preview/provision', {
      method: 'POST',
      headers: { authorization: `Bearer ${platformSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clerkUserId: 'user_123', handle: 'pr-897', runtimeSlot: 'pr-897' }),
    });

    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ status: 'provisioning' });
    expect(provisionPreview).toHaveBeenCalledWith({
      clerkUserId: 'user_123',
      handle: 'pr-897',
      runtimeSlot: 'pr-897',
    });
    expect(provision).not.toHaveBeenCalled();

    provisionPreview.mockRejectedValueOnce(new Error('provider token and private path leaked'));
    const failed = await app.request('/vps/preview/provision', {
      method: 'POST',
      headers: { authorization: `Bearer ${platformSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clerkUserId: 'user_123', handle: 'pr-898', runtimeSlot: 'pr-898' }),
    });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'Provisioning failed' });
  });

  it('rejects oversized preview provision bodies before parsing', async () => {
    const app = createApp();
    const res = await app.request('/vps/preview/provision', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${platformSecret}`,
        'content-type': 'application/json',
        'content-length': '5001',
      },
      body: JSON.stringify({ clerkUserId: 'user_123', handle: 'pr-897', runtimeSlot: 'pr-897', padding: 'x'.repeat(5000) }),
    });

    expect(res.status).toBe(413);
  });

  it('provisions, registers, reads status, and deletes through the route contract', async () => {
    const app = createApp();
    const adminHeaders = { authorization: `Bearer ${platformSecret}`, 'content-type': 'application/json' };

    const provision = await app.request('/vps/provision', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ clerkUserId: 'user_123', handle: 'alice' }),
    });
    expect(provision.status).toBe(202);
    const provisionBody = await provision.json();
    expect(provisionBody.status).toBe('provisioning');

    const register = await app.request('/vps/register', {
      method: 'POST',
      headers: { authorization: 'Bearer registration-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        machineId: provisionBody.machineId,
        hetznerServerId: 123456,
        publicIPv4: '203.0.113.10',
        imageVersion: 'matrix-os-host-2026.04.26-1',
      }),
    });
    expect(register.status).toBe(200);

    const status = await app.request(`/vps/${provisionBody.machineId}/status`, {
      headers: { authorization: `Bearer ${platformSecret}` },
    });
    expect(status.status).toBe(200);
    const statusBody = await status.json();
    expect(statusBody).toMatchObject({ status: 'running', handle: 'alice' });
    expect(statusBody).not.toHaveProperty('registrationTokenHash');
    expect(statusBody).not.toHaveProperty('registrationTokenExpiresAt');
    expect(statusBody).not.toHaveProperty('hetznerServerId');

    const deleted = await app.request(`/vps/${provisionBody.machineId}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${platformSecret}` },
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true, machineId: provisionBody.machineId, status: 'deleted' });
  });

  it('protects and validates the recover route contract', async () => {
    const service = {
      recover: vi.fn().mockResolvedValue({
        oldMachineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
        machineId: 'f973bb98-2538-4f9f-a10d-1be5920a7bf7',
        runtimeSlot: 'staging',
        status: 'recovering',
        etaSeconds: 120,
      }),
    } as unknown as Parameters<typeof createCustomerVpsRoutes>[0]['service'];
    const app = new Hono();
    app.route('/vps', createCustomerVpsRoutes({ service, platformSecret }));

    const unauthorized = await app.request('/vps/recover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clerkUserId: 'user_123' }),
    });
    expect(unauthorized.status).toBe(401);

    const invalid = await app.request('/vps/recover', {
      method: 'POST',
      headers: { authorization: `Bearer ${platformSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clerkUserId: '../user' }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'Invalid request' });

    const invalidSlot = await app.request('/vps/recover', {
      method: 'POST',
      headers: { authorization: `Bearer ${platformSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clerkUserId: 'user_123', runtimeSlot: 'staging-' }),
    });
    expect(invalidSlot.status).toBe(400);
    expect(await invalidSlot.json()).toEqual({ error: 'Invalid request' });

    const recover = await app.request('/vps/recover', {
      method: 'POST',
      headers: { authorization: `Bearer ${platformSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clerkUserId: 'user_123', runtimeSlot: 'staging', allowEmpty: true }),
    });

    expect(recover.status).toBe(202);
    expect(await recover.json()).toEqual({
      oldMachineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      machineId: 'f973bb98-2538-4f9f-a10d-1be5920a7bf7',
      runtimeSlot: 'staging',
      status: 'recovering',
      etaSeconds: 120,
    });
    expect(service.recover).toHaveBeenCalledWith({ clerkUserId: 'user_123', runtimeSlot: 'staging', allowEmpty: true });
  });

  it('protects and validates the machine resize route contract', async () => {
    const service = {
      resize: vi.fn().mockResolvedValue({
        machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
        serverType: 'cpx32',
        status: 'running',
      }),
    } as unknown as Parameters<typeof createCustomerVpsRoutes>[0]['service'];
    const app = new Hono();
    app.route('/vps', createCustomerVpsRoutes({ service, platformSecret }));

    const unauthorized = await app.request('/vps/9f05824c-8d0a-4d83-9cb4-b312d43ff112/resize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ serverType: 'cpx32' }),
    });
    expect(unauthorized.status).toBe(401);

    const invalidBody = await app.request('/vps/9f05824c-8d0a-4d83-9cb4-b312d43ff112/resize', {
      method: 'POST',
      headers: { authorization: `Bearer ${platformSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ serverType: '../../cpx32' }),
    });
    expect(invalidBody.status).toBe(400);
    expect(await invalidBody.json()).toEqual({ error: 'Invalid request' });

    const invalidMachine = await app.request('/vps/not-a-uuid/resize', {
      method: 'POST',
      headers: { authorization: `Bearer ${platformSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ serverType: 'cpx32' }),
    });
    expect(invalidMachine.status).toBe(400);
    expect(await invalidMachine.json()).toEqual({ error: 'Invalid request' });

    const resized = await app.request('/vps/9f05824c-8d0a-4d83-9cb4-b312d43ff112/resize', {
      method: 'POST',
      headers: { authorization: `Bearer ${platformSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ serverType: 'cpx32' }),
    });
    expect(resized.status).toBe(200);
    expect(await resized.json()).toEqual({
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      serverType: 'cpx32',
      status: 'running',
    });
    expect(service.resize).toHaveBeenCalledWith({
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      serverType: 'cpx32',
    });
  });

  it('rejects invalid request bodies with generic validation errors', async () => {
    const app = createApp();
    const res = await app.request('/vps/provision', {
      method: 'POST',
      headers: { authorization: `Bearer ${platformSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clerkUserId: 'u', handle: '../../etc' }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid request' });
  });

  it('deploys by channel through the route contract', async () => {
    const service = {
      deploy: vi.fn().mockResolvedValue({ triggered: 1, failed: 0, results: [] }),
    } as unknown as Parameters<typeof createCustomerVpsRoutes>[0]['service'];
    const app = new Hono();
    app.route('/vps', createCustomerVpsRoutes({ service, platformSecret }));

    const res = await app.request('/vps/deploy', {
      method: 'POST',
      headers: { authorization: `Bearer ${platformSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'dev' }),
    });

    expect(res.status).toBe(200);
    expect(service.deploy).toHaveBeenCalledWith({ channel: 'dev' });
  });

  it('deploys to a named VPS through the route contract', async () => {
    const service = {
      deploy: vi.fn().mockResolvedValue({ triggered: 1, failed: 0, results: [] }),
    } as unknown as Parameters<typeof createCustomerVpsRoutes>[0]['service'];
    const app = new Hono();
    app.route('/vps', createCustomerVpsRoutes({ service, platformSecret }));

    const res = await app.request('/vps/deploy', {
      method: 'POST',
      headers: { authorization: `Bearer ${platformSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'v083-elixir-symphony-202605261600-4c421d32', handle: 'hamedmp-elixir' }),
    });

    expect(res.status).toBe(200);
    expect(service.deploy).toHaveBeenCalledWith({
      version: 'v083-elixir-symphony-202605261600-4c421d32',
      handle: 'hamedmp-elixir',
    });
  });

  it('rejects ambiguous deploy targets', async () => {
    const service = {
      deploy: vi.fn(),
    } as unknown as Parameters<typeof createCustomerVpsRoutes>[0]['service'];
    const app = new Hono();
    app.route('/vps', createCustomerVpsRoutes({ service, platformSecret }));

    const res = await app.request('/vps/deploy', {
      method: 'POST',
      headers: { authorization: `Bearer ${platformSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'main-969a192-20260512142352', channel: 'dev' }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid request' });
    expect(service.deploy).not.toHaveBeenCalled();
  });

  it('rejects mutating bodies over 4096 bytes before parsing', async () => {
    const app = createApp();
    const res = await app.request('/vps/provision', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${platformSecret}`,
        'content-type': 'application/json',
        'content-length': '5001',
      },
      body: JSON.stringify({ clerkUserId: 'user_123', handle: 'alice', padding: 'x'.repeat(5000) }),
    });

    expect(res.status).toBe(413);
  });

  it('rejects resize bodies over 4096 bytes before parsing', async () => {
    const app = createApp();
    const res = await app.request('/vps/9f05824c-8d0a-4d83-9cb4-b312d43ff112/resize', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${platformSecret}`,
        'content-type': 'application/json',
        'content-length': '5001',
      },
      body: JSON.stringify({ serverType: 'cpx32', padding: 'x'.repeat(5000) }),
    });

    expect(res.status).toBe(413);
  });

  it('does not expose provider error details to clients', async () => {
    const service = {
      provision: vi.fn().mockRejectedValue(new Error('hetzner api token leaked')),
    } as unknown as Parameters<typeof createCustomerVpsRoutes>[0]['service'];
    const app = new Hono();
    app.route('/vps', createCustomerVpsRoutes({ service, platformSecret }));

    const res = await app.request('/vps/provision', {
      method: 'POST',
      headers: { authorization: `Bearer ${platformSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clerkUserId: 'user_123', handle: 'alice' }),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Provisioning failed' });
  });

  describe('fleet endpoints', () => {
    const sampleMachines = [
      {
        machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
        clerkUserId: 'user_alice',
        handle: 'alice',
        status: 'running' as const,
        imageVersion: 'matrix-os-host-2026.04.26-1',
        publicIPv4: '203.0.113.10',
        publicIPv6: null,
        provisionedAt: '2026-04-26T12:00:00.000Z',
        lastSeenAt: '2026-04-26T12:05:00.000Z',
        deletedAt: null,
        failureCode: null,
        failureAt: null,
      },
      {
        machineId: 'f973bb98-2538-4f9f-a10d-1be5920a7bf7',
        clerkUserId: 'user_bob',
        handle: 'bob',
        status: 'provisioning' as const,
        imageVersion: null,
        publicIPv4: null,
        publicIPv6: null,
        provisionedAt: '2026-04-26T12:10:00.000Z',
        lastSeenAt: null,
        deletedAt: null,
        failureCode: null,
        failureAt: null,
      },
    ];

    it('GET /fleet without auth returns 401', async () => {
      const service = {
        listAllMachines: vi.fn().mockResolvedValue(sampleMachines),
      } as unknown as Parameters<typeof createCustomerVpsRoutes>[0]['service'];
      const app = new Hono();
      app.route('/vps', createCustomerVpsRoutes({ service, platformSecret }));

      const res = await app.request('/vps/fleet');
      expect(res.status).toBe(401);
    });

    it('GET /fleet with auth returns fleet summary with correct shape', async () => {
      const service = {
        listAllMachines: vi.fn().mockResolvedValue(sampleMachines),
      } as unknown as Parameters<typeof createCustomerVpsRoutes>[0]['service'];
      const app = new Hono();
      app.route('/vps', createCustomerVpsRoutes({ service, platformSecret }));

      const res = await app.request('/vps/fleet', {
        headers: { authorization: `Bearer ${platformSecret}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.fleet).toMatchObject({
        total: 2,
        running: 1,
        provisioning: 1,
        failed: 0,
        versionDistribution: {
          'matrix-os-host-2026.04.26-1': 1,
          unknown: 1,
        },
        healthSummary: { healthy: 0, degraded: 1, unreachable: 1 },
      });
      expect(body.machines).toHaveLength(2);
      expect(body.machines[0]).toMatchObject({
        machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
        handle: 'alice',
        healthy: false,
      });
      expect(body.machines[1]).toMatchObject({
        machineId: 'f973bb98-2538-4f9f-a10d-1be5920a7bf7',
        handle: 'bob',
        healthy: false,
      });
    });

    it('GET /fleet with probeMachineHealth returning true marks machines as healthy', async () => {
      const service = {
        listAllMachines: vi.fn().mockResolvedValue(sampleMachines),
      } as unknown as Parameters<typeof createCustomerVpsRoutes>[0]['service'];
      const probeMachineHealth = vi.fn().mockResolvedValue(true);
      const app = new Hono();
      app.route('/vps', createCustomerVpsRoutes({ service, platformSecret, probeMachineHealth }));

      // Stub global fetch to avoid real network calls from the uptime probe
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ uptime: 3600 }), { status: 200 }));
      try {
        const res = await app.request('/vps/fleet', {
          headers: { authorization: `Bearer ${platformSecret}` },
        });
        expect(res.status).toBe(200);
        const body = await res.json();

        // Only the running machine (alice) should be probed
        expect(probeMachineHealth).toHaveBeenCalledTimes(1);
        expect(probeMachineHealth).toHaveBeenCalledWith(
          expect.objectContaining({
            machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
            handle: 'alice',
            publicIPv4: '203.0.113.10',
          }),
        );

        expect(body.machines[0]).toMatchObject({ handle: 'alice', healthy: true });
        expect(body.machines[1]).toMatchObject({ handle: 'bob', healthy: false });
        expect(body.fleet.healthSummary).toEqual({ healthy: 1, degraded: 0, unreachable: 1 });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('GET /fleet includes runtime probe metrics when available', async () => {
      const service = {
        listAllMachines: vi.fn().mockResolvedValue(sampleMachines),
      } as unknown as Parameters<typeof createCustomerVpsRoutes>[0]['service'];
      const probeMachineRuntime = vi.fn().mockResolvedValue({
        healthy: true,
        probeLatencyMs: 87,
        load1: 0.32,
        cpuCount: 2,
        memoryTotalBytes: 4 * 1024 * 1024 * 1024,
        memoryFreeBytes: 1024 * 1024 * 1024,
        diskTotalBytes: 40 * 1024 * 1024 * 1024,
        diskFreeBytes: 30 * 1024 * 1024 * 1024,
      });
      const app = new Hono();
      app.route('/vps', createCustomerVpsRoutes({ service, platformSecret, probeMachineRuntime }));

      const res = await app.request('/vps/fleet', {
        headers: { authorization: `Bearer ${platformSecret}` },
      });
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(probeMachineRuntime).toHaveBeenCalledTimes(1);
      expect(body.machines[0]).toMatchObject({
        handle: 'alice',
        healthy: true,
        probeLatencyMs: 87,
        load1: 0.32,
        cpuCount: 2,
        memoryTotalBytes: 4294967296,
        memoryFreeBytes: 1073741824,
        diskTotalBytes: 42949672960,
        diskFreeBytes: 32212254720,
      });
    });

  });
});
