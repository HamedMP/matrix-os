import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import {
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
  let db: PlatformDB;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await insertContainer(db, {
      handle: 'alice',
      clerkUserId: 'user_alice',
      port: 5001,
      shellPort: 6001,
      status: 'running',
    });
  });

  afterEach(async () => {
    await destroyTestPlatformDb(db);
    vi.restoreAllMocks();
  });

  it('builds a customer VPS HTTPS proxy URL from a running machine', () => {
    expect(buildCustomerVpsProxyUrl({
      status: 'running',
      publicIPv4: '203.0.113.10',
    }, '/api/ping', '?x=1')).toBe('https://203.0.113.10:443/api/ping?x=1');
  });

  it('routes /proxy/:handle requests to a running VPS before legacy containers', async () => {
    await insertUserMachine(db, {
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
    expect(fetchMock.mock.calls[0]?.[1]?.dispatcher).toBeDefined();
    expect(docker.getContainer).not.toHaveBeenCalled();
  });

  it('routes /proxy/:handle requests to a staging VPS handle', async () => {
    await insertUserMachine(db, {
      machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff113',
      clerkUserId: 'user_alice',
      handle: 'alice-staging',
      runtimeSlot: 'staging',
      status: 'running',
      hetznerServerId: 123457,
      publicIPv4: '203.0.113.11',
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

    const res = await app.request('/proxy/alice-staging/api/ping?x=1', {
      headers: { authorization: 'Bearer platform-secret', host: 'alice-staging.matrix-os.com' },
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://203.0.113.11:443/api/ping?x=1');
    expect(fetchMock.mock.calls[0]?.[1]?.dispatcher).toBeDefined();
    expect(docker.getContainer).not.toHaveBeenCalled();
  });

  it('routes public app-domain Twilio webhooks to the matching VPS by handle', async () => {
    await insertUserMachine(db, {
      machineId: '0b5d0a5f-52d8-4f4d-aed8-8d2a0ad1a591',
      clerkUserId: 'user_alice',
      handle: 'alice',
      status: 'running',
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.04.26-1',
      provisionedAt: '2026-04-26T12:00:00.000Z',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: 'platform-secret',
    });

    const res = await app.request('/voice/webhook/twilio?handle=alice', {
      method: 'POST',
      headers: {
        host: 'app.matrix-os.com',
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': 'signed',
      },
      body: 'CallSid=CA123',
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://203.0.113.10:443/voice/webhook/twilio?handle=alice',
    );
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get('x-twilio-signature')).toBe('signed');
    expect(headers.get('authorization')).toBeTruthy();
    expect(headers.get('x-forwarded-host')).toBe('app.matrix-os.com');
  });

  it('routes public app-domain Twilio webhooks to a staging VPS handle', async () => {
    await insertUserMachine(db, {
      machineId: '0b5d0a5f-52d8-4f4d-aed8-8d2a0ad1a592',
      clerkUserId: 'user_alice',
      handle: 'alice-staging',
      runtimeSlot: 'staging',
      status: 'running',
      hetznerServerId: 123457,
      publicIPv4: '203.0.113.11',
      imageVersion: 'matrix-os-host-2026.04.26-1',
      provisionedAt: '2026-04-26T12:00:00.000Z',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const app = createApp({
      db,
      orchestrator: stubOrchestrator(),
      platformSecret: 'platform-secret',
    });

    const res = await app.request('/voice/webhook/twilio?handle=alice-staging', {
      method: 'POST',
      headers: {
        host: 'app.matrix-os.com',
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': 'signed',
      },
      body: 'CallSid=CA123',
    });

    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://203.0.113.11:443/voice/webhook/twilio?handle=alice-staging',
    );
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
