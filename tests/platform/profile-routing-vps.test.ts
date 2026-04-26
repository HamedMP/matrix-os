import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  createPlatformDb,
  insertContainer,
  insertUserMachine,
  type PlatformDB,
} from '../../packages/platform/src/db.js';
import { createApp } from '../../packages/platform/src/main.js';
import { buildCustomerVpsProxyUrl } from '../../packages/platform/src/profile-routing.js';
import type { Orchestrator } from '../../packages/platform/src/orchestrator.js';
import type Dockerode from 'dockerode';

function stubOrchestrator(): Orchestrator {
  return {
    provision: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    destroy: vi.fn(),
    upgrade: vi.fn(),
    rollingRestart: vi.fn(),
    getInfo: vi.fn(),
    getImage: vi.fn(),
    listAll: vi.fn().mockReturnValue([]),
    syncStates: vi.fn(),
  };
}

function stubDocker(): Dockerode {
  return {
    getContainer: vi.fn(() => ({
      inspect: vi.fn().mockResolvedValue({
        Id: 'docker-ctr-1',
        State: { Running: true },
        NetworkSettings: {
          Networks: {
            'matrixos-net': { IPAddress: '172.18.0.14' },
          },
        },
      }),
    })),
  } as unknown as Dockerode;
}

describe('platform/profile-routing-vps', () => {
  let tmpDir: string;
  let db: PlatformDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'profile-routing-vps-'));
    db = createPlatformDb(join(tmpDir, 'test.db'));
    insertContainer(db, {
      handle: 'alice',
      clerkUserId: 'user_alice',
      port: 5001,
      shellPort: 6001,
      status: 'running',
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('builds a customer VPS HTTPS proxy URL from a running machine', () => {
    expect(buildCustomerVpsProxyUrl({
      status: 'running',
      publicIPv4: '203.0.113.10',
    }, '/api/ping', '?x=1')).toBe('https://203.0.113.10:443/api/ping?x=1');
  });

  it('routes /proxy/:handle requests to a running VPS before legacy containers', async () => {
    insertUserMachine(db, {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
      clerkUserId: 'user_alice',
      handle: 'alice',
      status: 'running',
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
      provisionedAt: '2026-04-26T12:00:00.000Z',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const docker = stubDocker();
    const app = createApp({
      db,
      docker,
      orchestrator: stubOrchestrator(),
      platformSecret: 'platform-secret',
    });

    const res = await app.request('/proxy/alice/api/ping?x=1', {
      headers: { authorization: 'Bearer platform-secret', host: 'alice.matrix-os.com' },
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://203.0.113.10:443/api/ping?x=1');
    expect(docker.getContainer).not.toHaveBeenCalled();
  });

  it('falls back to the legacy container route when no running VPS exists', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const docker = stubDocker();
    const app = createApp({
      db,
      docker,
      orchestrator: stubOrchestrator(),
      platformSecret: 'platform-secret',
    });

    const res = await app.request('/proxy/alice/api/ping', {
      headers: { authorization: 'Bearer platform-secret' },
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://matrixos-alice:3000/api/ping');
  });
});

