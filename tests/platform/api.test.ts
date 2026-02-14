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
    },
    mockContainer,
  };
}

describe('platform/api', () => {
  let tmpDir: string;
  let db: PlatformDB;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'platform-api-'));
    db = createPlatformDb(join(tmpDir, 'test.db'));
    const { docker } = createMockDocker();
    const orchestrator = createOrchestrator({ db, docker: docker as any });
    app = createApp({ db, orchestrator });
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
      headers: { 'content-type': 'application/json' },
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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'alice' }),
    });
    expect(res.status).toBe(400);
  });

  it('GET /containers lists all containers', async () => {
    await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'alice', clerkUserId: 'c1' }),
    });
    await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'bob', clerkUserId: 'c2' }),
    });

    const res = await app.request('/containers');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  it('GET /containers/:handle returns container info', async () => {
    await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'alice', clerkUserId: 'c1' }),
    });

    const res = await app.request('/containers/alice');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handle).toBe('alice');
  });

  it('GET /containers/:handle returns 404 for unknown handle', async () => {
    const res = await app.request('/containers/ghost');
    expect(res.status).toBe(404);
  });

  it('POST /containers/:handle/stop stops a container', async () => {
    await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'alice', clerkUserId: 'c1' }),
    });

    const res = await app.request('/containers/alice/stop', { method: 'POST' });
    expect(res.status).toBe(200);

    const info = await app.request('/containers/alice');
    const body = await info.json();
    expect(body.status).toBe('stopped');
  });

  it('DELETE /containers/:handle destroys a container', async () => {
    await app.request('/containers/provision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'alice', clerkUserId: 'c1' }),
    });

    const res = await app.request('/containers/alice', { method: 'DELETE' });
    expect(res.status).toBe(200);

    const info = await app.request('/containers/alice');
    expect(info.status).toBe(404);
  });
});
