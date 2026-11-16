import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPUTE_MODE_HEADER } from '@matrix-os/contracts';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { getUserMachine, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { DEFAULT_COMPUTE_CAP_CONFIG, monthStartUtc, nextMonthStartUtc } from '../../packages/platform/src/free-tier/compute-meter.js';
import { createApp } from '../../packages/platform/src/main.js';
import { buildPlatformWebSocketUpgradeHeaders } from '../../packages/platform/src/session-routing-websocket.js';
import { shutdownPlatformApp } from '../../packages/platform/src/shutdown-platform-app.js';
import { createContainerLifecycleService } from '../../packages/platform/src/substrates/container-lifecycle-service.js';
import type { ContainerProvider, ContainerUnit } from '../../packages/platform/src/substrates/container-provider.js';
import { createContainerSubstrate } from '../../packages/platform/src/substrates/container-substrate.js';
import { createSubstrateRegistry } from '../../packages/platform/src/substrates/registry.js';
import { createVpsSubstrate } from '../../packages/platform/src/substrates/vps-substrate.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';

/**
 * The gateway on a container unit learns its compute mode only from the
 * platform: a client must never choose it, and a VPS never receives it.
 */

const OWNER = 'user_modeowner';
const ENDPOINT = 'mvm-1.lambda-microvm.eu-west-1.on.aws';
const OWNER_SESSION = { host: 'app.matrix-os.com', authorization: `Bearer ${OWNER}` };
const ROUTES = ['/api/chats', '/vm/modeowner/api/chats'];

function fakeProvider(now: () => Date): ContainerProvider {
  const unit: ContainerUnit = {
    unitId: 'mvm-1', state: 'pending', endpointHost: ENDPOINT, createdAt: now(), expiresAt: new Date(now().getTime() + 8 * 3_600_000),
  };
  return {
    run: vi.fn(async () => unit),
    suspend: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    terminate: vi.fn(async () => undefined),
    describe: vi.fn(async () => null),
    list: vi.fn(async () => []),
    mintEndpointCredential: vi.fn(async () => ({ headers: { 'X-aws-proxy-auth': 'minted' }, expiresAt: new Date(now().getTime() + 30 * 60_000) })),
  };
}

describe('the compute mode header on container proxying', () => {
  let db: PlatformDB;
  let lifecycle: ReturnType<typeof createContainerLifecycleService>;
  let platform: ReturnType<typeof createApp>;
  let fetchMock: ReturnType<typeof vi.spyOn>;

  async function build(input: { atCap: boolean; now?: () => Date }) {
    const now = input.now ?? (() => new Date());
    await insertUserMachine(db, {
      machineId: 'ctr-1', clerkUserId: OWNER, handle: 'modeowner', status: 'stopped', imageVersion: null,
      provisionedAt: now().toISOString(), substrate: 'container',
    });
    if (input.atCap) {
      await db.executor.insertInto('runtime_compute_usage').values({
        clerk_user_id: OWNER, month_start: monthStartUtc(now()).toISOString().slice(0, 10),
        billed_ms: DEFAULT_COMPUTE_CAP_CONFIG.capMs, export_ms: 0, export_wakes: 0,
      }).execute();
    }
    const provider = fakeProvider(now);
    lifecycle = createContainerLifecycleService({ db, provider, buildBootPayload: async () => '{}', computeCap: DEFAULT_COMPUTE_CAP_CONFIG, now });
    const container = createContainerSubstrate({
      lifecycle, provider, endpointHostSuffix: '.on.aws', loadMachine: (machineId) => getUserMachine(db, machineId), now,
    });
    platform = createApp({
      db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret-123', env: {},
      clerkAuth: createClerkAuth({ verifyToken: async (token) => ({ sub: token }) }),
      substrateRegistry: createSubstrateRegistry([createVpsSubstrate({ loadMachine: async () => undefined }), container]),
    });
  }

  async function startUnit(headers: Record<string, string>) {
    await platform.request('/api/system/export', { headers });
    await lifecycle.drain();
    const machine = (await getUserMachine(db, 'ctr-1'))!;
    expect(await lifecycle.markRegistered('ctr-1', machine.generation)).toBe('ok');
    fetchMock.mockClear();
  }

  function forwardedMode(): (string | null)[] {
    return fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers as Headers).map((headers) => headers.get(COMPUTE_MODE_HEADER));
  }

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('runtime', { status: 200 }));
  });

  afterEach(async () => {
    await lifecycle?.shutdown();
    if (platform) await shutdownPlatformApp(platform);
    vi.restoreAllMocks();
    await destroyTestPlatformDb(db);
  });

  it('sends full from the row and replaces a client-sent export_only on both route kinds', async () => {
    await build({ atCap: false });
    await startUnit(OWNER_SESSION);
    for (const path of ROUTES) {
      const response = await platform.request(path, { headers: { ...OWNER_SESSION, [COMPUTE_MODE_HEADER]: 'export_only' } });
      expect(response.status, path).toBe(200);
    }
    expect(forwardedMode()).toEqual(['full', 'full']);
  });

  it('sends export_only from the row, replaces a client-sent full, and still refuses non-export requests', async () => {
    await build({ atCap: true });
    await startUnit({ ...OWNER_SESSION, 'x-matrix-export': '1' });
    expect((await getUserMachine(db, 'ctr-1'))?.computeMode).toBe('export_only');
    for (const path of ROUTES) {
      const response = await platform.request(path, { headers: { ...OWNER_SESSION, [COMPUTE_MODE_HEADER]: 'full' } });
      expect(response.status, path).toBe(200);
    }
    expect(forwardedMode()).toEqual(['export_only', 'export_only']);
    const refused = await platform.request('/api/projects', { headers: { ...OWNER_SESSION, [COMPUTE_MODE_HEADER]: 'full' } });
    expect(refused.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('computes Retry-After at the cap from the injected clock', async () => {
    const fixed = new Date('2026-09-10T12:00:00.000Z');
    await build({ atCap: true, now: () => fixed });
    const response = await platform.request('/api/projects', { headers: OWNER_SESSION });
    expect(response.status).toBe(429);
    const resetsAt = nextMonthStartUtc(fixed);
    expect(await response.json()).toMatchObject({ resetsAt: resetsAt.toISOString() });
    expect(response.headers.get('retry-after')).toBe(String((resetsAt.getTime() - fixed.getTime()) / 1_000));
  });
});

describe('the compute mode header on VPS proxying', () => {
  let db: PlatformDB;
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('runtime', { status: 200 }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await destroyTestPlatformDb(db);
  });

  it('never forwards a client-sent value to a VPS', async () => {
    await insertUserMachine(db, {
      machineId: 'machine-alice', clerkUserId: 'user_alice', handle: 'alice', status: 'running', hetznerServerId: 4242,
      publicIPv4: '203.0.113.50', imageVersion: 'matrix-os-host-dev', provisionedAt: '2026-11-01T00:00:00.000Z',
    });
    const platform = createApp({
      db, orchestrator: stubOrchestrator(), platformSecret: 'platform-secret-123',
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue({ sub: 'user_alice' }) }),
    });
    for (const path of ['/vm/alice/api/projects', '/api/projects']) {
      const response = await platform.request(path, {
        headers: { host: 'app.matrix-os.com', authorization: 'Bearer clerk-session', [COMPUTE_MODE_HEADER]: 'export_only' },
      });
      expect(response.status, path).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) expect(((init as RequestInit).headers as Headers).has(COMPUTE_MODE_HEADER)).toBe(false);
    await shutdownPlatformApp(platform);
  });

  it('drops a client-sent value from forwarded WebSocket upgrade headers', () => {
    const headers = buildPlatformWebSocketUpgradeHeaders({
      incomingHeaders: { [COMPUTE_MODE_HEADER]: 'full', 'X-Matrix-Compute-Mode': 'export_only', 'sec-websocket-version': '13' } as never,
      externalHost: 'app.matrix-os.com', handle: 'alice', userId: 'user_alice', platformSecret: 's', includePlatformProof: true, isCodeDomain: false,
    });
    expect(headers.toLowerCase()).not.toContain(COMPUTE_MODE_HEADER);
    expect(headers).toContain('sec-websocket-version: 13');
  });
});
