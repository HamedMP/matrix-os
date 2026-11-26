import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlatformDB } from '../../packages/platform/src/db.js';
import { OwnedCloudflareError, type OwnedCloudflareClient } from '../../packages/platform/src/owned-machines/cloudflare.js';
import type { OwnedMachinesConfig } from '../../packages/platform/src/owned-machines/config.js';
import { createOwnedMachineRoutes } from '../../packages/platform/src/owned-machines/machine-routes.js';
import { createOwnedOwnerRoutes } from '../../packages/platform/src/owned-machines/owner-routes.js';
import { getOwnedMachineLink } from '../../packages/platform/src/owned-machines/repository.js';
import { runOwnedTunnelReconcilePass, runOwnedTunnelWorkPass } from '../../packages/platform/src/owned-machines/tunnel-worker.js';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './native-platform-db-test-helper.js';

const SECRET = 's'.repeat(48);
const CONFIG: OwnedMachinesConfig = {
  cloudflare: { apiBase: 'https://cf.test', accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), apiToken: 't'.repeat(40) },
  hostSuffix: 'm.example.net',
  hostPrefix: '',
  ingressService: 'http://127.0.0.1:8790',
  access: { clientId: 'client-id-1', clientSecret: 'client-secret-123456' },
  publicUrl: 'https://app.example.com',
  platformInternalUrl: 'https://platform.example.com',
  platformSecret: SECRET,
  updateChannel: 'stable',
  fundedAiEnabled: true,
  fundedAiRelayUrl: 'https://relay.example.com',
  platformSpeechEnabled: false,
};
const REPORT = { hostname: 'lab-box', os: 'Ubuntu 24.04', arch: 'x86_64', agentVersion: '2026.11.1' };

function fakeCloudflare() {
  const tunnels = new Map<string, { id: string; name: string }>();
  const dns = new Set<string>();
  const calls: string[] = [];
  let failCreates = 0;
  let n = 0;
  const client: OwnedCloudflareClient = {
    async findTunnelByName(name) {
      calls.push(`find:${name}`);
      const found = [...tunnels.values()].find((t) => t.name === name);
      return found ? { ...found, createdAt: null } : null;
    },
    async createTunnel(name) {
      calls.push('create');
      if (failCreates > 0) { failCreates -= 1; throw new OwnedCloudflareError('tunnel_create', 503, true); }
      n += 1;
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      tunnels.set(id, { id, name });
      return { id, name, createdAt: null };
    },
    async getTunnelToken(id) { calls.push(`token:${id}`); return `token-${id.slice(-4)}`; },
    async configureTunnel(id, hostname, service) { calls.push(`config:${hostname}:${service}`); },
    async ensureDnsRecord(hostname) { dns.add(hostname); },
    async deleteDnsRecord(hostname) { dns.delete(hostname); calls.push('dns-delete'); },
    async deleteTunnel(id) { tunnels.delete(id); calls.push(`delete:${id}`); },
    async listTunnelsPage() { return [...tunnels.values()].map((t) => ({ ...t, createdAt: null })); },
  };
  return { client, tunnels, dns, calls, failNextCreates: (count: number) => { failCreates = count; } };
}

let clock = Date.now();
const now = () => new Date(clock);
function tick(ms = 6_000) { clock += ms; }

function buildApp(db: PlatformDB, cloudflare: OwnedCloudflareClient, config: OwnedMachinesConfig | null = CONFIG) {
  const app = new Hono();
  const log = () => undefined;
  app.route('/', createOwnedMachineRoutes({ db, config, cloudflare, log, now }));
  app.route('/', createOwnedOwnerRoutes({
    db, config, platformJwtSecret: 'jwt', publishableKey: null, log, now,
    resolveHandle: async () => 'alice',
    resolveIdentity: async (opts) => {
      const auth = opts.authHeader ?? '';
      if (auth === 'Bearer owner-token') return { userId: 'user_1' } as never;
      if (auth === 'Bearer other-token') return { userId: 'user_2' } as never;
      if (!auth && opts.cookieHeader?.includes('session=owner')) return { userId: 'user_1' } as never;
      return null;
    },
  }));
  return app;
}

function json(body: unknown, headers: Record<string, string> = {}) {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

describe('owned machine enrollment and machine routes', () => {
  let db: PlatformDB;
  beforeEach(async () => { ({ db } = await createTestPlatformDb()); });
  afterEach(async () => { await destroyTestPlatformDb(db); });

  async function enrollAndApprove(app: Hono) {
    const start = await app.request('/api/machines/enroll/start', json(REPORT));
    expect(start.status).toBe(200);
    const issued = await start.json() as { deviceCode: string; userCode: string; verificationUriComplete: string };
    expect(issued.verificationUriComplete).toContain('/connect?code=');
    const lookup = await app.request('/api/auth/owned-enrollments/lookup',
      json({ userCode: issued.userCode }, { authorization: 'Bearer owner-token' }));
    expect(await lookup.json()).toMatchObject({ report: REPORT });
    const approved = await app.request('/api/auth/owned-enrollments/approve',
      json({ userCode: issued.userCode, name: 'Lab' }, { authorization: 'Bearer owner-token' }));
    expect(approved.status).toBe(201);
    return { ...issued, ...(await approved.json() as { machineId: string }) };
  }

  it('enrolls, provisions a tunnel, delivers credentials once, heartbeats and revokes', async () => {
    const cf = fakeCloudflare();
    const app = buildApp(db, cf.client);
    const { deviceCode, machineId } = await enrollAndApprove(app);

    expect(await (await app.request('/api/machines/enroll/poll', json({ deviceCode }))).json()).toEqual({ status: 'pending' });
    await runOwnedTunnelWorkPass({ db, cloudflare: cf.client, hostSuffix: CONFIG.hostSuffix, ingressService: CONFIG.ingressService, now });
    expect(cf.calls.some((call) => call.startsWith('config:') && call.endsWith(':http://127.0.0.1:8790'))).toBe(true);

    tick();
    const ready = await (await app.request('/api/machines/enroll/poll', json({ deviceCode }))).json() as {
      status: string; env: Record<string, string>; tunnelToken: string;
    };
    expect(ready.status).toBe('ready');
    expect(ready.tunnelToken).toMatch(/^token-/);
    expect(ready.env.MATRIX_SUBSTRATE).toBe('owned');
    expect(ready.env.UPGRADE_TOKEN).not.toBe(buildPlatformVerificationToken('alice', SECRET));
    expect(Object.keys(ready.env)).not.toContain('DATABASE_URL');
    tick();
    expect(await (await app.request('/api/machines/enroll/poll', json({ deviceCode }))).json()).toEqual({ status: 'expired' });

    const machineHeaders = { authorization: `Bearer ${ready.env.UPGRADE_TOKEN}`, 'x-matrix-machine-id': machineId };
    const beat = await app.request('/api/machines/heartbeat',
      json({ agentVersion: '2026.11.1', uptimeSec: 10, diskFreeBytes: 1_000_000, gatewayHealthy: true }, machineHeaders));
    expect(await beat.json()).toMatchObject({ status: 'ok', tunnel: 'ok', autoSecurityUpdates: true, backupsEnabled: false });
    const unhealthyMachine = await getOwnedMachineLink(db, machineId);
    expect(unhealthyMachine?.machine.status).toBe('running');
    const forged = await app.request('/api/machines/heartbeat',
      json({ agentVersion: '1', uptimeSec: 1, diskFreeBytes: 1, gatewayHealthy: true },
        { authorization: `Bearer ${buildPlatformVerificationToken('alice', SECRET)}`, 'x-matrix-machine-id': machineId }));
    expect(forged.status).toBe(401);

    const list = await (await app.request('/api/auth/owned-computers', { headers: { authorization: 'Bearer owner-token' } })).json() as {
      computers: Array<{ status: string; name: string }>;
    };
    expect(list.computers).toMatchObject([{ status: 'online', name: 'Lab' }]);

    const patched = await app.request(`/api/auth/owned-computers/${machineId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', authorization: 'Bearer owner-token' },
      body: JSON.stringify({ backupsEnabled: true, name: 'Lab 2' }),
    });
    expect(await patched.json()).toMatchObject({ backupsEnabled: true, name: 'Lab 2' });

    expect((await app.request(`/api/auth/owned-computers/${machineId}`, {
      method: 'DELETE', headers: { authorization: 'Bearer other-token' },
    })).status).toBe(404);
    expect((await app.request(`/api/auth/owned-computers/${machineId}`, {
      method: 'DELETE', headers: { cookie: 'session=owner' },
    })).status).toBe(401);
    expect((await app.request(`/api/auth/owned-computers/${machineId}`, {
      method: 'PATCH', body: JSON.stringify({ name: 'Lab 3' }),
      headers: { 'content-type': 'application/json', cookie: 'session=owner', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    })).status).toBe(401);
    expect((await app.request(`/api/auth/owned-computers/${machineId}`, {
      method: 'PATCH', body: JSON.stringify({ name: 'Lab 3' }),
      headers: { 'content-type': 'application/json', cookie: 'session=owner', origin: 'https://app.example.com', 'sec-fetch-site': 'same-origin' },
    })).status).toBe(200);
    expect((await app.request(`/api/auth/owned-computers/${machineId}`, {
      method: 'DELETE', headers: { authorization: 'Bearer owner-token' },
    })).status).toBe(204);

    const afterRevoke = await app.request('/api/machines/heartbeat',
      json({ agentVersion: '2026.11.1', uptimeSec: 10, diskFreeBytes: 1, gatewayHealthy: true }, machineHeaders));
    expect(afterRevoke.status).toBe(401);
    expect(cf.tunnels.size).toBe(1);
    await runOwnedTunnelWorkPass({ db, cloudflare: cf.client, hostSuffix: CONFIG.hostSuffix, ingressService: CONFIG.ingressService, now });
    expect(cf.tunnels.size).toBe(0);
    expect(cf.dns.size).toBe(0);
  });

  it('cuts access at commit even when the Cloudflare delete fails', async () => {
    const cf = fakeCloudflare();
    const app = buildApp(db, cf.client);
    const { machineId } = await enrollAndApprove(app);
    await runOwnedTunnelWorkPass({ db, cloudflare: cf.client, hostSuffix: CONFIG.hostSuffix, ingressService: CONFIG.ingressService, now });
    cf.client.deleteTunnel = async () => { throw new OwnedCloudflareError('tunnel_delete', 503, true); };
    expect((await app.request(`/api/auth/owned-computers/${machineId}`, {
      method: 'DELETE', headers: { authorization: 'Bearer owner-token' },
    })).status).toBe(204);
    await runOwnedTunnelWorkPass({ db, cloudflare: cf.client, hostSuffix: CONFIG.hostSuffix, ingressService: CONFIG.ingressService, now });
    const link = await getOwnedMachineLink(db, machineId);
    expect(link?.revokedAt).not.toBeNull();
    expect(link?.machine.deletedAt).not.toBeNull();
    expect(link?.tunnelState).toBe('deleting');
  });

  it('retries a failed tunnel create without leaving the machine routable', async () => {
    const cf = fakeCloudflare();
    cf.failNextCreates(1);
    const app = buildApp(db, cf.client);
    const { machineId, deviceCode } = await enrollAndApprove(app);
    await runOwnedTunnelWorkPass({ db, cloudflare: cf.client, hostSuffix: CONFIG.hostSuffix, ingressService: CONFIG.ingressService, now });
    expect((await getOwnedMachineLink(db, machineId))?.tunnelState).toBe('pending');
    expect(await (await app.request('/api/machines/enroll/poll', json({ deviceCode }))).json()).toEqual({ status: 'pending' });
    await runOwnedTunnelWorkPass({
      db, cloudflare: cf.client, hostSuffix: CONFIG.hostSuffix, ingressService: CONFIG.ingressService,
      now: () => new Date(clock + 3_600_000),
    });
    expect((await getOwnedMachineLink(db, machineId))?.tunnelState).toBe('ready');
    expect(cf.tunnels.size).toBe(1);
  });

  it('rejects unknown device codes, unauthenticated approval and oversized bodies', async () => {
    const app = buildApp(db, fakeCloudflare().client);
    const poll = await app.request('/api/machines/enroll/poll', json({ deviceCode: 'A'.repeat(43) }));
    expect(await poll.json()).toEqual({ status: 'expired' });
    const anon = await app.request('/api/auth/owned-enrollments/approve', json({ userCode: 'BCDF-GHJK', name: 'x' }));
    expect(anon.status).toBe(401);
    const big = await app.request('/api/machines/enroll/start', json({ ...REPORT, hostname: 'h'.repeat(20_000) }));
    expect(big.status).toBe(413);
  });

  it('answers 503, not 404, when the feature is misconfigured', async () => {
    const app = buildApp(db, fakeCloudflare().client, null);
    expect((await app.request('/api/machines/enroll/start', json(REPORT))).status).toBe(503);
    expect((await app.request('/api/auth/owned-computers', { headers: { authorization: 'Bearer owner-token' } })).status).toBe(503);
  });

  it('names preview tunnels with the host prefix and never reconciles another environment\'s tunnels', async () => {
    const cf = fakeCloudflare();
    const app = buildApp(db, cf.client);
    await enrollAndApprove(app);
    const deps = { db, cloudflare: cf.client, hostSuffix: 'example.com', hostPrefix: 'eng524-preview-', ingressService: CONFIG.ingressService, now };
    await runOwnedTunnelWorkPass(deps);
    const [created] = [...cf.tunnels.values()];
    expect(created?.name).toMatch(/^eng524-preview-matrix-owned-[0-9a-f-]{36}$/);
    expect(cf.calls.find((call) => call.startsWith('config:'))).toMatch(/^config:eng524-preview-[0-9a-f]{16}\.example\.com:/);
    const prodId = '00000000-0000-4000-8000-999999999999';
    const orphanId = '00000000-0000-4000-8000-888888888888';
    cf.tunnels.set(prodId, { id: prodId, name: 'matrix-owned-11111111-1111-4111-8111-111111111111' });
    cf.tunnels.set(orphanId, { id: orphanId, name: 'eng524-preview-matrix-owned-22222222-2222-4222-8222-222222222222' });
    cf.client.listTunnelsPage = async () => [...cf.tunnels.values()].map((t) => ({ ...t, createdAt: new Date(0) }));
    await runOwnedTunnelReconcilePass(deps);
    expect(cf.tunnels.has(prodId)).toBe(true);
    expect(cf.tunnels.has(orphanId)).toBe(false);
    expect(cf.tunnels.has(created!.id)).toBe(true);
  });

  it('refuses to connect a computer once account deletion is scheduled', async () => {
    const { hashAccountDeletionOwner } = await import('../../packages/platform/src/account-deletion/repository.js');
    const previous = process.env.ACCOUNT_DELETION_SECRET;
    process.env.ACCOUNT_DELETION_SECRET = 'd'.repeat(40);
    try {
      const at = new Date(clock).toISOString();
      await db.executor.insertInto('account_deletion_jobs').values({
        owner_hash: hashAccountDeletionOwner('user_1', 'd'.repeat(40)), status: 'scheduled',
        due_at: new Date(clock + 86_400_000).toISOString(), next_attempt_at: at, created_at: at, updated_at: at,
      } as never).execute();
      const app = buildApp(db, fakeCloudflare().client);
      const start = await (await app.request('/api/machines/enroll/start', json(REPORT))).json() as { userCode: string };
      const approved = await app.request('/api/auth/owned-enrollments/approve',
        json({ userCode: start.userCode, name: 'Lab' }, { authorization: 'Bearer owner-token' }));
      expect(approved.status).toBe(409);
      expect(await approved.json()).toMatchObject({ code: 'account_deletion_pending' });
    } finally {
      if (previous === undefined) delete process.env.ACCOUNT_DELETION_SECRET;
      else process.env.ACCOUNT_DELETION_SECRET = previous;
    }
  });

  it('renders the connect page without echoing an invalid code', async () => {
    const app = buildApp(db, fakeCloudflare().client);
    const page = await (await app.request('/connect?code=%3Cscript%3E')).text();
    expect(page).not.toContain('<script>alert');
    expect(page).toContain('value=""');
  });

  it('resumes the orphan scan where the last pass stopped', async () => {
    const pages: number[] = [];
    const client = fakeCloudflare().client;
    client.listTunnelsPage = async (page) => {
      pages.push(page);
      return Array.from({ length: 50 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(page * 100 + i).padStart(12, '0')}`, name: 'other', createdAt: new Date(0) }));
    };
    const deps = { db, cloudflare: client, hostSuffix: 'example.com', ingressService: CONFIG.ingressService, now };
    const next = await runOwnedTunnelReconcilePass(deps);
    expect(next).toBe(21);
    expect(await runOwnedTunnelReconcilePass(deps, next)).toBe(41);
    expect(pages[20]).toBe(21);
  });

  it('keeps a machine whose gateway is down from turning online', async () => {
    const cf = fakeCloudflare();
    const app = buildApp(db, cf.client);
    const { deviceCode, machineId } = await enrollAndApprove(app);
    await runOwnedTunnelWorkPass({ db, cloudflare: cf.client, hostSuffix: CONFIG.hostSuffix, ingressService: CONFIG.ingressService, now });
    tick();
    const ready = await (await app.request('/api/machines/enroll/poll', json({ deviceCode }))).json() as { env: Record<string, string> };
    const headers = { authorization: `Bearer ${ready.env.UPGRADE_TOKEN}`, 'x-matrix-machine-id': machineId };
    const beat = await app.request('/api/machines/heartbeat',
      json({ agentVersion: '1', uptimeSec: 1, diskFreeBytes: 1, gatewayHealthy: false }, headers));
    expect(beat.status).toBe(200);
    const link = await getOwnedMachineLink(db, machineId);
    expect(link?.machine.status).toBe('enrolling');
    expect(link?.lastHeartbeatAt).toBeNull();
  });

  it('removes owned machines during account deletion without hosted-VPS settings', async () => {
    const { createAccountDeletionAdapters } = await import('../../packages/platform/src/account-deletion/adapters.js');
    const cf = fakeCloudflare();
    const app = buildApp(db, cf.client);
    const { machineId } = await enrollAndApprove(app);
    await runOwnedTunnelWorkPass({ db, cloudflare: cf.client, hostSuffix: CONFIG.hostSuffix, ingressService: CONFIG.ingressService, now });
    const adapters = createAccountDeletionAdapters({ db, clerkSecretKey: 'key', r2PrefixRoot: 'sync',
      fetch: async () => Response.json({ data: [], total_count: 0 }) });
    const ctx = { clerkUserId: 'user_1' } as Parameters<typeof adapters.vps>[0];
    await expect(adapters.vps(ctx)).rejects.toThrow('Owned runtime tunnel cleanup pending');
    const revoked = await getOwnedMachineLink(db, machineId);
    expect(revoked?.revokedAt).not.toBeNull();
    expect(revoked?.machine.deletedAt).not.toBeNull();
    await runOwnedTunnelWorkPass({ db, cloudflare: cf.client, hostSuffix: CONFIG.hostSuffix, ingressService: CONFIG.ingressService, now });
    await expect(adapters.vps(ctx)).resolves.toBeUndefined();
    expect(cf.tunnels.size).toBe(0);
  });
});
