import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { buildOwnedMachineVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createSiteDataTransport } from '../../packages/platform/src/sites/data-transport.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { createSiteSubmissionTransport } from '../../packages/platform/src/sites/submission-transport.js';
import { createPlatformSubstrateRegistry } from '../../packages/platform/src/substrates/platform-substrates.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

// Spec 2707: a site published from an owned computer reaches it only through its
// tunnel, with the owned bearer, Access credentials, and verified TLS, never the
// customer VPS pool (which skips certificate checks when CUSTOMER_VPS_TLS_VERIFY=false).
const SECRET = 'sites-owned-platform-secret-123456789';
const HOST = '0123456789abcdef.m.example.net';
const OWNED = { hostSuffix: 'm.example.net', access: { clientId: 'access-id', clientSecret: 'access-secret' } };
const machine = {
  machineId: '4f7c2d1e-5a6b-4c3d-8e9f-0a1b2c3d4e5f', clerkUserId: 'user_alice', handle: 'alice',
  runtimeSlot: 'owned-0a1b2c3d', provisioningClass: 'owned', substrate: 'owned' as const, status: 'running',
  privateAddress: HOST, lastSeenAt: new Date().toISOString(), provisionedAt: '2026-11-01T00:00:00.000Z',
};
const vpsPool = { pool: 'customer-vps' };
let db: PlatformDB;

beforeAll(async () => {
  db = (await createTestPlatformDb()).db;
  await insertUserMachine(db, machine);
});
afterAll(async () => { await destroyTestPlatformDb(db); });
afterEach(() => { vi.unstubAllGlobals(); });

async function deploySite() {
  const service = createSitesService({ db, storage: { async putObject() { return {}; }, async getObject() { return { body: null }; } } });
  return service.deploy({ ownerId: 'user_alice', machineId: machine.machineId, appSlug: `event-${Math.random().toString(36).slice(2, 8)}` },
    { title: 'Event', config: { forms: [{ id: 'rsvp', title: 'RSVP', fields: { email: { type: 'email', required: true } } }] },
      files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('Event').toString('base64') }] });
}

function expectOwnedTunnelRequest(call: unknown[], path: string) {
  const [url, init] = call as [string, RequestInit & { dispatcher?: unknown }];
  expect(url).toBe(`https://${HOST}${path}`);
  expect(init.dispatcher).toBeDefined();
  expect(init.dispatcher).not.toBe(vpsPool);
  const headers = new Headers(init.headers);
  expect(headers.get('cf-access-client-id')).toBe('access-id');
  expect(headers.get('x-matrix-upstream-host')).toBe(HOST);
  expect(headers.get('authorization')).toBe(`Bearer ${buildOwnedMachineVerificationToken(
    { handle: machine.handle, machineId: machine.machineId, runtimeSlot: machine.runtimeSlot }, SECRET, 1)}`);
  expect(headers.get('x-matrix-site-signature')).toMatch(/^[a-f0-9]{64}$/);
}

it('submits an owned site form through the tunnel with verified TLS', async () => {
  const site = await deploySite();
  const fetcher = vi.fn(async () => Response.json({ accepted: true }));
  vi.stubGlobal('fetch', fetcher);
  const submit = createSiteSubmissionTransport({ platformSecret: SECRET, dispatcher: vpsPool as never,
    substrates: createPlatformSubstrateRegistry(db, {}, { owned: OWNED }) });
  await expect(submit(site, db, 'rsvp', { fields: { email: 'guest@example.com' }, idempotencyKey: 'stable-rsvp-request' }))
    .resolves.toEqual({ accepted: true });
  expectOwnedTunnelRequest(fetcher.mock.calls[0]!, `/api/internal/sites/${site.id}/submit`);
});

it('forwards an owned site data read through the tunnel with verified TLS', async () => {
  const site = await deploySite();
  const fetcher = vi.fn(async () => Response.json({ result: 'stored' }));
  vi.stubGlobal('fetch', fetcher);
  const transport = createSiteDataTransport({ db, platformSecret: SECRET, dispatcher: vpsPool as never,
    substrates: createPlatformSubstrateRegistry(db, {}, { owned: OWNED }) });
  await expect(transport.forward(site, 'a'.repeat(64), { kind: 'kvRead', key: 'greeting' }))
    .resolves.toEqual({ ok: true, result: 'stored' });
  expectOwnedTunnelRequest(fetcher.mock.calls[0]!, `/api/internal/sites/${site.id}/data`);
});

it('fails an owned site data read closed while the computer is offline', async () => {
  const site = await deploySite();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const transport = createSiteDataTransport({ db, platformSecret: SECRET, dispatcher: vpsPool as never,
    substrates: createPlatformSubstrateRegistry(db, {}, {}) });
  await expect(transport.forward(site, 'a'.repeat(64), { kind: 'kvRead', key: 'greeting' })).rejects.toMatchObject({ code: 'unavailable' });
  expect(fetcher).not.toHaveBeenCalled();
});
