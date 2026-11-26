import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { insertUserMachine, type NewUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createApp } from '../../packages/platform/src/main.js';
import { projectComputer } from '../../packages/platform/src/computer-routes.js';
import { buildOwnedMachineVerificationToken, buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { matchRuntimeBearerForHandle } from '../../packages/platform/src/runtime-auth.js';
import { createOwnedSubstrate } from '../../packages/platform/src/substrates/owned-substrate.js';
import { createPlatformSubstrateRegistry } from '../../packages/platform/src/substrates/platform-substrates.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';

const SECRET = 'platform-secret-123';
const CLERK_SESSION = { host: 'app.matrix-os.com', authorization: 'Bearer clerk-session' };
const OWNED = { hostSuffix: 'm.example.net', access: { clientId: 'access-id', clientSecret: 'access-secret' } };
const HOST = '0123456789abcdef.m.example.net';
const SLOT = 'owned-0a1b2c3d';

function owned(overrides: Partial<NewUserMachine> = {}): NewUserMachine {
  return {
    machineId: '4f7c2d1e-5a6b-4c3d-8e9f-0a1b2c3d4e5f',
    clerkUserId: 'user_alice',
    handle: 'alice',
    runtimeSlot: SLOT,
    provisioningClass: 'owned',
    substrate: 'owned',
    status: 'running',
    privateAddress: HOST,
    lastSeenAt: new Date().toISOString(),
    provisionedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function app(db: PlatformDB) {
  return createApp({
    db,
    orchestrator: stubOrchestrator(),
    clerkAuth: createClerkAuth({ verifyToken: vi.fn().mockResolvedValue({ sub: 'user_alice' }) }),
    platformSecret: SECRET,
    substrateRegistry: createPlatformSubstrateRegistry(db, {}, { owned: OWNED }),
    env: { ...process.env, MATRIX_PAID_BETA_ENTITLEMENT_STATUS: 'missing' },
  });
}

describe('owned substrate', () => {
  const substrate = createOwnedSubstrate({ ...OWNED, loadMachine: async () => undefined, now: () => Date.parse('2026-11-22T10:00:00Z') });
  const base = { handle: 'alice', status: 'running', substrate: 'owned' as const, publicIPv4: null, privateAddress: HOST };

  it('routes only to a suffix-bound tunnel host with a fresh heartbeat', () => {
    const fresh = { ...base, lastSeenAt: '2026-11-22T09:59:30Z' };
    expect(substrate.resolveUpstream(fresh, { path: '/api/x', queryString: 'a=1' })).toEqual({
      url: `https://${HOST}/api/x?a=1`, hostHeader: HOST, tlsServerName: HOST,
      headers: { 'cf-access-client-id': 'access-id', 'cf-access-client-secret': 'access-secret' },
    });
    expect(substrate.resolveUpstream({ ...fresh, lastSeenAt: '2026-11-22T09:58:00Z' }, { path: '/' })).toBeNull();
    expect(substrate.resolveUpstream({ ...fresh, privateAddress: 'evil.example.com' }, { path: '/' })).toBeNull();
    expect(substrate.resolveUpstream({ ...fresh, privateAddress: `x.${HOST}` }, { path: '/' })).toBeNull();
    expect(substrate.resolveUpstream({ ...fresh, status: 'enrolling' }, { path: '/' })).toBeNull();
  });

  it('requires the environment prefix and omits Access headers when none are configured', () => {
    const prefixed = createOwnedSubstrate({ hostSuffix: 'example.com', hostPrefix: 'eng524-preview-',
      loadMachine: async () => undefined, now: () => Date.parse('2026-11-22T10:00:00Z') });
    const machine = { ...base, lastSeenAt: '2026-11-22T09:59:30Z', privateAddress: 'eng524-preview-0123456789abcdef.example.com' };
    expect(prefixed.resolveUpstream(machine, { path: '/' })).toEqual({
      url: 'https://eng524-preview-0123456789abcdef.example.com/',
      hostHeader: 'eng524-preview-0123456789abcdef.example.com',
      tlsServerName: 'eng524-preview-0123456789abcdef.example.com',
    });
    expect(prefixed.resolveUpstream({ ...machine, privateAddress: '0123456789abcdef.example.com' }, { path: '/' })).toBeNull();
  });
});

describe('session routing to owned machines', () => {
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

  it('proxies through the tunnel with the owned bearer, user proof and origin headers, and no paid plan', async () => {
    await insertUserMachine(db, owned());
    const res = await app(db).request(`/vm/alice/~runtime/${SLOT}/api/projects`, {
      headers: { ...CLERK_SESSION, 'cf-access-client-secret': 'forged' },
    });
    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    const token = buildOwnedMachineVerificationToken(
      { handle: 'alice', machineId: owned().machineId, runtimeSlot: SLOT }, SECRET, 1);
    expect(url).toBe(`https://${HOST}/api/projects`);
    expect(headers.get('host')).toBe(HOST);
    expect(headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(headers.get('authorization')).not.toBe(`Bearer ${buildPlatformVerificationToken('alice', SECRET)}`);
    expect(headers.get('x-platform-verified')).toBe(createHmac('sha256', token).update('user_alice').digest('hex'));
    expect(headers.get('cf-access-client-secret')).toBe('access-secret');
  });

  it('shows the offline page and JSON instead of a 502 when the heartbeat is stale', async () => {
    await insertUserMachine(db, owned({ lastSeenAt: '2026-11-01T00:00:00.000Z' }));
    const page = await app(db).request(`/vm/alice/~runtime/${SLOT}/`, { headers: CLERK_SESSION });
    expect(page.status).toBe(503);
    expect(await page.text()).toContain('Your computer is offline');
    const api = await app(db).request(`/vm/alice/~runtime/${SLOT}/api/projects`, { headers: CLERK_SESSION });
    expect(api.status).toBe(503);
    expect(await api.json()).toEqual({ error: 'computer_offline' });
    expect(api.headers.get('retry-after')).toBe('30');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the offline page when the tunnel is down or unreachable despite a fresh heartbeat', async () => {
    await insertUserMachine(db, owned());
    fetchMock.mockResolvedValueOnce(new Response('error code: 1033', { status: 530 }));
    const down = await app(db).request(`/vm/alice/~runtime/${SLOT}/api/projects`, { headers: CLERK_SESSION });
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: 'computer_offline' });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const unreachable = await app(db).request(`/vm/alice/~runtime/${SLOT}/`, { headers: CLERK_SESSION });
    expect(unreachable.status).toBe(503);
    expect(await unreachable.text()).toContain('Your computer is offline');
  });

  it('lists owned computers only for clients that ask for them', async () => {
    await insertUserMachine(db, owned());
    const legacy = await app(db).request('/api/auth/computers', { headers: CLERK_SESSION });
    expect((await legacy.json() as { items: unknown[] }).items).toEqual([]);
    const current = await app(db).request('/api/auth/computers?include=owned', { headers: CLERK_SESSION });
    const unsupported = await app(db).request('/api/auth/computers?include=everything', { headers: CLERK_SESSION });
    expect(unsupported.status).toBe(400);
    expect((await current.json() as { items: unknown[] }).items).toMatchObject([
      { kind: 'owned', label: 'Own Computer', availability: 'available', runtimeSlot: SLOT },
    ]);
  });
});

describe('owned computer projection and machine bearers', () => {
  it('projects enrolling, online and offline states', () => {
    const now = Date.parse('2026-11-22T10:00:00Z');
    const record = { handle: 'alice', runtimeSlot: SLOT, provisioningClass: 'owned' as const, imageVersion: null, privateAddress: HOST };
    expect(projectComputer({ ...record, status: 'enrolling' }, now)?.availability).toBe('starting');
    expect(projectComputer({ ...record, status: 'running', lastSeenAt: '2026-11-22T09:59:50Z' }, now)?.availability).toBe('available');
    expect(projectComputer({ ...record, status: 'running', lastSeenAt: '2026-11-22T09:00:00Z' }, now)?.availability).toBe('unavailable');
  });

  it('accepts a live owned machine bearer for its handle and rejects it after revocation', async () => {
    const { db } = await createTestPlatformDb();
    try {
      await insertUserMachine(db, owned());
      const token = buildOwnedMachineVerificationToken({ handle: 'alice', machineId: owned().machineId, runtimeSlot: SLOT }, SECRET, 1);
      expect(await matchRuntimeBearerForHandle(db, 'alice', token, SECRET)).toBe(token);
      expect(await matchRuntimeBearerForHandle(db, 'bob', token, SECRET)).toBeNull();
      await db.executor.updateTable('user_machines').set({ runtime_token_epoch: 2 }).execute();
      expect(await matchRuntimeBearerForHandle(db, 'alice', token, SECRET)).toBeNull();
    } finally {
      await destroyTestPlatformDb(db);
    }
  });
});

describe('owned machine revocation hooks', () => {
  it('unpublishes every site of the removed machine, past one batch, and no other machine\'s', async () => {
    const { unpublishOwnedMachineSites } = await import('../../packages/platform/src/owned-machines/revocation-hooks.js');
    const { db } = await createTestPlatformDb();
    try {
      await insertUserMachine(db, owned());
      const machine = await db.executor.selectFrom('user_machines').selectAll().executeTakeFirstOrThrow();
      const rows = Array.from({ length: 205 }, (_, i) => ({
        id: `site-${String(i).padStart(4, '0')}`, owner_id: 'user_alice',
        machine_id: i === 204 ? 'other-machine' : owned().machineId,
        app_slug: `app-${i}`, title: 't', description: 'd', slug: null, revision: 1, status: 'published' as const,
        active_version: null, created_at: '2026-11-01T00:00:00.000Z',
      }));
      await db.executor.insertInto('public_sites').values(rows as never).execute();
      const { mapUserMachine } = await import('../../packages/platform/src/database/user-machine-records.js');
      await db.transaction((trx) => unpublishOwnedMachineSites(trx, mapUserMachine(machine), new Date()));
      const published = await db.executor.selectFrom('public_sites').select('id').where('status', '=', 'published').execute();
      expect(published.map((row) => row.id)).toEqual(['site-0204']);
    } finally {
      await destroyTestPlatformDb(db);
    }
  });
});
