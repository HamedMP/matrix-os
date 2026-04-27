import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createPlatformDb, type PlatformDB } from '../../packages/platform/src/db.js';
import { createCustomerVpsService } from '../../packages/platform/src/customer-vps.js';
import { loadCustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { hashRegistrationToken } from '../../packages/platform/src/customer-vps-auth.js';
import { createCustomerVpsRoutes } from '../../packages/platform/src/customer-vps-routes.js';
import { createMockCustomerVpsSystemStore, createMockHetznerClient } from './customer-vps-fixtures.js';

describe('platform/customer-vps-routes', () => {
  let tmpDir: string;
  let db: PlatformDB;
  const platformSecret = 'platform-secret';

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'customer-vps-routes-'));
    db = createPlatformDb(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createApp() {
    const service = createCustomerVpsService({
      db,
      config: loadCustomerVpsConfig({
        PLATFORM_PORT: '9000',
        HETZNER_API_TOKEN: 'token',
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

    const recover = await app.request('/vps/recover', {
      method: 'POST',
      headers: { authorization: `Bearer ${platformSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clerkUserId: 'user_123', allowEmpty: true }),
    });

    expect(recover.status).toBe(202);
    expect(await recover.json()).toEqual({
      oldMachineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      machineId: 'f973bb98-2538-4f9f-a10d-1be5920a7bf7',
      status: 'recovering',
      etaSeconds: 120,
    });
    expect(service.recover).toHaveBeenCalledWith({ clerkUserId: 'user_123', allowEmpty: true });
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
});
