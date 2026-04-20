import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createPlatformDb, type PlatformDB, insertContainer } from '../../packages/platform/src/db.js';
import { createOrchestrator } from '../../packages/platform/src/orchestrator.js';
import { createApp } from '../../packages/platform/src/main.js';

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

describe('platform/api', () => {
  let tmpDir: string;
  let db: PlatformDB;
  let app: ReturnType<typeof createApp>;
  const platformSecret = 'platform-secret-123';
  const adminHeaders = { authorization: `Bearer ${platformSecret}` };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'platform-api-'));
    db = createPlatformDb(join(tmpDir, 'test.db'));
    const { docker } = createMockDocker();
    const orchestrator = createOrchestrator({ db, docker: docker as any });
    app = createApp({ db, orchestrator, platformSecret });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
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
