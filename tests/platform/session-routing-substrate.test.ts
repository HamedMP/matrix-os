import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { getVpsBootPage } from '../../packages/platform/src/auth-pages.js';
import { insertUserMachine, type NewUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createApp } from '../../packages/platform/src/main.js';
import { createSubstrateRegistry } from '../../packages/platform/src/substrates/registry.js';
import { createVpsSubstrate } from '../../packages/platform/src/substrates/vps-substrate.js';
import type { RuntimeSubstrate } from '../../packages/platform/src/substrates/types.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';

const CLERK_SESSION = { host: 'app.matrix-os.com', authorization: 'Bearer clerk-session' };

function machine(overrides: Partial<NewUserMachine> = {}): NewUserMachine {
  return {
    machineId: 'machine-alice',
    clerkUserId: 'user_alice',
    handle: 'alice',
    status: 'running',
    hetznerServerId: 4242,
    publicIPv4: '203.0.113.50',
    imageVersion: 'matrix-os-host-dev',
    provisionedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function app(db: PlatformDB, extra: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({
    db,
    orchestrator: stubOrchestrator(),
    clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue({ sub: 'user_alice' }) }),
    platformSecret: 'platform-secret-123',
    ...extra,
  });
}

function proxiedRequest(fetchMock: ReturnType<typeof vi.spyOn>) {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
  return { url, host: (init.headers as Headers).get('host') };
}

describe('session routing through runtime substrates', () => {
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

  it('proxies an explicit /vm route to the running VPS with its handle host', async () => {
    await insertUserMachine(db, machine());

    const res = await app(db).request('/vm/alice/api/projects?view=list', { headers: CLERK_SESSION });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('runtime');
    expect(proxiedRequest(fetchMock)).toEqual({
      url: 'https://203.0.113.50:443/api/projects?view=list',
      host: 'alice.matrix-os.com',
    });
  });

  it('proxies a session-routed request to the running VPS with its handle host', async () => {
    await insertUserMachine(db, machine());

    const res = await app(db).request('/api/projects?view=list', { headers: CLERK_SESSION });

    expect(res.status).toBe(200);
    expect(proxiedRequest(fetchMock)).toEqual({
      url: 'https://203.0.113.50:443/api/projects?view=list',
      host: 'alice.matrix-os.com',
    });
  });

  it('keeps recovery traffic on the predecessor for both route kinds', async () => {
    await insertUserMachine(db, machine({
      status: 'recovering', publicIPv4: '203.0.113.51', recoveryOldServerId: 4241, recoveryOldPublicIPv4: '203.0.113.49',
    }));

    expect((await app(db).request('/vm/alice/api/health', { headers: CLERK_SESSION })).status).toBe(200);
    expect((await app(db).request('/api/health', { headers: CLERK_SESSION })).status).toBe(200);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://203.0.113.49:443/api/health',
      'https://203.0.113.49:443/api/health',
    ]);
  });

  it.each(['provisioning', 'resizing'])('serves the unchanged boot responses while a VPS is %s', async (status) => {
    await insertUserMachine(db, machine({ status, publicIPv4: status === 'resizing' ? '203.0.113.50' : null }));
    const platform = app(db);

    for (const path of ['/vm/alice/', '/vm/alice/api/health']) {
      const page = await platform.request(path, { headers: CLERK_SESSION });
      expect(page.status, path).toBe(503);
      expect(await page.text(), path).toBe(getVpsBootPage({ status }));
    }

    const session = await platform.request('/api/health', { headers: CLERK_SESSION });
    expect(session.status).toBe(503);
    expect(await session.json()).toEqual({ error: 'VPS provisioning', status });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('denies runtime access without a paid entitlement before checking routability', async () => {
    await insertUserMachine(db, machine({ machineId: 'machine-running' }));
    await insertUserMachine(db, machine({
      machineId: 'machine-booting', handle: 'alice-two', runtimeSlot: 'two', status: 'provisioning', publicIPv4: null,
    }));
    const platform = app(db, { env: { ...process.env, MATRIX_PAID_BETA_ENTITLEMENT_STATUS: 'missing' } });

    for (const path of ['/vm/alice/api/projects', '/vm/alice-two/api/projects', '/api/projects']) {
      const res = await platform.request(path, { method: 'POST', headers: CLERK_SESSION, body: '{}' });
      expect(res.status, path).toBe(402);
      expect(await res.json(), path).toEqual({ error: 'Paid beta access required' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers 503 without proxying when the runtime substrate is not configured', async () => {
    await insertUserMachine(db, machine({
      substrate: 'container', hetznerServerId: null, publicIPv4: '203.0.113.50', privateAddress: '10.0.0.5',
    }));
    const platform = app(db);

    for (const path of ['/vm/alice/api/projects', '/api/projects']) {
      const res = await platform.request(path, { headers: CLERK_SESSION });
      expect(res.status, path).toBe(503);
      expect(await res.text(), path).toBe('Matrix OS computer unavailable');
      expect(res.headers.get('cache-control'), path).toContain('no-store');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes through the injected registry for each substrate kind', async () => {
    await insertUserMachine(db, machine({ substrate: 'container', hetznerServerId: null, publicIPv4: null }));
    const container: RuntimeSubstrate = {
      kind: 'container',
      startsOnDemand: true,
      resolveUpstream: (record, target) => ({
        url: `https://runtime-${record.handle}.internal:8443${target.path}${target.queryString ?? ''}`,
        hostHeader: `${record.handle}.matrix-os.com`,
      }),
      ensureRunning: async () => ({ state: 'running' }),
    };
    const substrateRegistry = createSubstrateRegistry([
      createVpsSubstrate({ loadMachine: async () => undefined }),
      container,
    ]);

    const res = await app(db, { substrateRegistry }).request('/vm/alice/api/projects?x=1', { headers: CLERK_SESSION });

    expect(res.status).toBe(200);
    expect(proxiedRequest(fetchMock)).toEqual({
      url: 'https://runtime-alice.internal:8443/api/projects?x=1',
      host: 'alice.matrix-os.com',
    });
  });
});
