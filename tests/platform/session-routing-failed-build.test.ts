import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { getVpsBootPage } from '../../packages/platform/src/auth-pages.js';
import { insertUserMachine, type NewUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createApp } from '../../packages/platform/src/main.js';
import { createMetalHostsRepository } from '../../packages/platform/src/substrates/metal-hosts-repository.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';

/**
 * An owner whose first build failed must reach the onboarding shell, which
 * shows provisioning_failed with Try again. Fault detected: the app domain
 * answered every browser request with the "Booting Matrix OS" page for any
 * non-running runtime, including a failed one and a metal one whose
 * registration window closed, so the retry was unreachable forever.
 */

const CLERK_SESSION = { host: 'app.matrix-os.com', authorization: 'Bearer clerk-session' };
const AUTH_SHELL = 'http://127.0.0.1:3200';

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

async function metalMachine(db: PlatformDB, overrides: Partial<NewUserMachine>) {
  await createMetalHostsRepository(db.kysely).upsert({
    id: 'host-a', name: 'host-a', apiUrl: 'https://host-a.metal.example.test:8443', ingressHost: 'host-a.metal.example.test',
    status: 'active', memoryCapacityMib: 131072, admissionCeilingMib: 114688,
  });
  await insertUserMachine(db, machine({
    substrate: 'metal', hetznerServerId: null, publicIPv4: null, metalHostId: 'host-a',
    metalVmId: 'vm_0123456789abcdef01234567', privateAddress: '10.78.0.14', status: 'provisioning',
    ...overrides,
  }));
}

describe('app-domain routing after a failed first build', () => {
  let db: PlatformDB;
  let fetchMock: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('auth shell', { status: 200 }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await destroyTestPlatformDb(db);
  });

  function platform() {
    return createApp({
      db,
      orchestrator: stubOrchestrator(),
      clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue({ sub: 'user_alice' }) }),
      platformSecret: 'platform-secret-123',
    });
  }

  it.each(['/', '/?billing=setup&handoff=add-computer', '/_next/static/chunks/app.js'])(
    'serves the onboarding shell, not the boot page, for %s when the build failed',
    async (path) => {
      await insertUserMachine(db, machine({ status: 'failed', publicIPv4: null, hetznerServerId: null }));

      const res = await platform().request(path, { headers: CLERK_SESSION });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('auth shell');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]![0])).toBe(`${AUTH_SHELL}${path}`);
    },
  );

  it('keeps the JSON 503 for gateway paths of a failed runtime', async () => {
    await insertUserMachine(db, machine({ status: 'failed', publicIPv4: null, hetznerServerId: null }));

    const res = await platform().request('/api/health', { headers: CLERK_SESSION });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'VPS provisioning', status: 'failed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves the onboarding shell for a metal runtime whose registration window closed', async () => {
    await metalMachine(db, { registrationTokenExpiresAt: '2020-01-01T00:00:00.000Z' });

    const res = await platform().request('/', { headers: CLERK_SESSION });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('auth shell');
  });

  it('keeps the boot page while a metal runtime is still inside its registration window', async () => {
    await metalMachine(db, { registrationTokenExpiresAt: '2099-01-01T00:00:00.000Z' });

    const res = await platform().request('/', { headers: CLERK_SESSION });

    expect(res.status).toBe(503);
    expect(await res.text()).toBe(getVpsBootPage({ status: 'provisioning' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
