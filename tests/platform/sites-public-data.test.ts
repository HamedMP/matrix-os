import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { buildPlatformSyncVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { createSitePublicRoutes } from '../../packages/platform/src/sites/public-routes.js';
import { createSiteSubmissionTransport } from '../../packages/platform/src/sites/submission-transport.js';
import { createSiteDataTransport } from '../../packages/platform/src/sites/data-transport.js';
import worker from '../../packages/edge-router/src/sites.js';

const identity = { handle: 'tasks-host', machineId: 'c3346b7a-3c41-47d5-b0c1-4209aef7b00c', runtimeSlot: 'primary' };
const secret = 'sites-scoped-platform-secret-123456789';
const edge = 'verified-edge-proof-secret-1234567890';
let db: PlatformDB;
let service: ReturnType<typeof createSitesService>;
let publicSite: { id: string; activeVersion: string | null };
let privateSite: { id: string };

const files = [{ path: 'index.html', contentType: 'text/html' as const, body: Buffer.from('Tasks').toString('base64') }];
beforeAll(async () => {
  db = (await createTestPlatformDb()).db;
  await insertUserMachine(db, { ...identity, clerkUserId: 'user_tasks_host', runtimeTokenEpoch: 2, status: 'running', publicIPv4: '93.184.216.34', provisionedAt: new Date().toISOString() });
  service = createSitesService({ db, storage: { async putObject() { return {}; }, async getObject() { return { body: null }; } } });
  const owner = { ownerId: 'user_tasks_host', machineId: identity.machineId };
  publicSite = await service.deploy({ ...owner, appSlug: 'tasks-lab' }, { title: 'Tasks', config: {}, files });
  privateSite = await service.deploy({ ...owner, appSlug: 'notes' }, { title: 'Notes', accessMode: 'private_link', config: {}, files });
});
afterAll(async () => { await destroyTestPlatformDb(db); });
afterEach(() => { vi.unstubAllGlobals(); });

function routes(env: NodeJS.ProcessEnv = {}) {
  return createSitePublicRoutes({ service, edgeSecret: edge, submit: createSiteSubmissionTransport({ platformSecret: secret }),
    data: { transport: createSiteDataTransport({ db, platformSecret: secret }), env } });
}
function post(app: ReturnType<typeof routes>, path: string, body: unknown, headers: Record<string, string> = {}) {
  return app.request(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: {
    'x-matrix-sites-edge': edge, 'x-matrix-sites-origin': 'same-origin', 'x-matrix-sites-source': '203.0.113.9', 'content-type': 'application/json', ...headers,
  } });
}
const find = { kind: 'db', action: { action: 'find', table: 'tasks' } };
const insert = { kind: 'db', action: { action: 'insert', table: 'tasks', data: { title: 'Plan' } } };

describe('platform public site data route', () => {
  it('forwards a signed, app-scoped capability with a per-site visitor hash and relays the result', async () => {
    const forward = vi.fn(async () => Response.json({ result: [{ id: 'row-1', title: 'Plan' }] }));
    vi.stubGlobal('fetch', forward);
    const response = await post(routes(), `/${publicSite.id}/data`, find);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: [{ id: 'row-1', title: 'Plan' }] });
    const [url, init] = forward.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://93.184.216.34:443/api/internal/sites/${publicSite.id}/data`);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    const body = init.body as string;
    expect(headers.get('x-matrix-site-signature')).toBe(createHmac('sha256', buildPlatformSyncVerificationToken(identity, secret, 2)).update(`${headers.get('x-matrix-site-timestamp')}.${body}`).digest('hex'));
    const capability = JSON.parse(body);
    expect(capability).toMatchObject({ siteId: publicSite.id, appSlug: 'tasks-lab', versionId: publicSite.activeVersion, request: find });
    expect(capability.visitor).toMatch(/^[a-f0-9]{64}$/);
    expect(body).not.toContain('203.0.113.9');
    const transport = createSiteDataTransport({ db, platformSecret: secret });
    expect(transport.visitorHash(publicSite.id, '203.0.113.9')).toBe(capability.visitor);
    expect(transport.visitorHash(privateSite.id, '203.0.113.9')).not.toBe(capability.visitor);
  });

  it('forwards writes inside the publication admission and maps gateway faults to generic errors', async () => {
    const forward = vi.fn(async () => Response.json({ error: 'duplicate key value violates unique constraint "tasks_pkey"' }, { status: 400 }));
    vi.stubGlobal('fetch', forward);
    const invalid = await post(routes(), `/${publicSite.id}/data`, insert);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'Invalid change' });
    forward.mockImplementation(async () => new Response('Postgres is down at /var/run', { status: 500 }));
    const down = await post(routes(), `/${publicSite.id}/data`, insert);
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: 'Shared data is unavailable' });
    forward.mockImplementation(async () => new Response('x'.repeat(1024 * 1024 + 4096)));
    expect((await post(routes(), `/${publicSite.id}/data`, find)).status).toBe(503);
  });

  it('runs one owner\'s visitor writes concurrently instead of through the single publish admission', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const forward = vi.fn(async () => { await gate; return Response.json({ result: { id: 'row' } }); });
    vi.stubGlobal('fetch', forward);
    const app = routes();
    const first = post(app, `/${publicSite.id}/data`, insert, { 'x-matrix-sites-source': '192.0.2.10' });
    const second = post(app, `/${publicSite.id}/data`, insert, { 'x-matrix-sites-source': '192.0.2.11' });
    await vi.waitFor(() => expect(forward).toHaveBeenCalledTimes(2));
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });

  it('re-checks the publication under the row lock before forwarding a write', async () => {
    const forward = vi.fn(async () => Response.json({ result: { id: 'row' } }));
    vi.stubGlobal('fetch', forward);
    const transport = createSiteDataTransport({ db, platformSecret: secret });
    const site = (await service.resolve(publicSite.id))!;
    await db.executor.updateTable('public_sites').set({ access_mode: 'private_link' }).where('id', '=', publicSite.id).execute();
    try {
      await expect(transport.forwardWrite(site, 'a'.repeat(64), insert as never)).rejects.toMatchObject({ code: 'not_found' });
      expect(forward).not.toHaveBeenCalled();
    } finally {
      await db.executor.updateTable('public_sites').set({ access_mode: 'public' }).where('id', '=', publicSite.id).execute();
    }
  });

  it('refuses private-link sites, unknown references and requests without the same-origin edge marker', async () => {
    const forward = vi.fn(async () => Response.json({ result: [] }));
    vi.stubGlobal('fetch', forward);
    expect((await post(routes(), `/${privateSite.id}/data`, find)).status).toBe(404);
    expect((await post(routes(), `/missing-site/data`, find)).status).toBe(404);
    expect((await post(routes(), `/${publicSite.id}/data`, find, { 'x-matrix-sites-origin': 'cross-site' })).status).toBe(404);
    expect((await post(routes(), `/${publicSite.id}/data`, find, { 'x-matrix-sites-edge': 'wrong-proof-secret-123456789012345' })).status).toBe(404);
    expect(forward).not.toHaveBeenCalled();
  });

  it('validates every body field with per-action schemas and never lets the visitor name an app', async () => {
    const forward = vi.fn(async () => Response.json({ result: [] }));
    vi.stubGlobal('fetch', forward);
    const app = routes();
    for (const body of [
      '{not json',
      { kind: 'db', action: { action: 'listApps' } },
      { kind: 'db', action: { action: 'find', table: 'tasks', app: 'other-app' } },
      { kind: 'db', action: { action: 'find', table: 'Robert"); DROP' } },
      { kind: 'db', action: { action: 'bulkInsert', table: 'tasks', rows: Array.from({ length: 51 }, () => ({ title: 'x' })) } },
      { kind: 'kvWrite', key: '../secrets', value: 'x' },
      { kind: 'terminal', command: 'ls' },
    ]) expect((await post(app, `/${publicSite.id}/data`, body)).status).toBe(400);
    expect((await post(app, `/${publicSite.id}/data`, { ...insert, pad: 'x'.repeat(70 * 1024) })).status).toBe(413);
    expect(forward).not.toHaveBeenCalled();
  });

  it('honours the operator kill switch without affecting page reads', async () => {
    const forward = vi.fn(async () => Response.json({ result: [] }));
    vi.stubGlobal('fetch', forward);
    const response = await post(routes({ SITES_PUBLIC_DATA: 'off' }), `/${publicSite.id}/data`, find);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Shared data is unavailable' });
    expect(forward).not.toHaveBeenCalled();
  });

  it('rate-limits each visitor source, with a stricter write window', async () => {
    const forward = vi.fn(async () => Response.json({ result: { id: 'row' } }));
    vi.stubGlobal('fetch', forward);
    const app = routes();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await post(app, `/${publicSite.id}/data`, insert, { 'x-matrix-sites-source': '198.51.100.7' })).status);
    expect(statuses.slice(0, 60).every((status) => status === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    expect((await post(app, `/${publicSite.id}/data`, find, { 'x-matrix-sites-source': '198.51.100.7' })).status).toBe(200);
    expect((await post(app, `/${publicSite.id}/data`, insert, { 'x-matrix-sites-source': '198.51.100.8' })).status).toBe(200);
  });
});

describe('sites Worker data path', () => {
  const env = { SITES_PLATFORM_ORIGIN: 'https://platform.example.com', SITES_EDGE_SECRET: 'x'.repeat(40) };
  it('forwards same-origin data calls with the edge proof and same-origin marker', async () => {
    const forward = vi.fn(async (_request: Request) => Response.json({ result: [] }));
    vi.stubGlobal('fetch', forward);
    const response = await worker.fetch(new Request('https://matrix.page/tasks-lab/data', { method: 'POST', headers: { origin: 'https://matrix.page', 'content-type': 'application/json' }, body: JSON.stringify(find) }), env);
    expect(response.status).toBe(200);
    const upstream = forward.mock.calls[0]![0];
    expect(upstream.url).toBe('https://platform.example.com/public/sites/tasks-lab/data');
    expect(upstream.headers.get('x-matrix-sites-origin')).toBe('same-origin');
    expect(upstream.headers.get('x-matrix-sites-edge')).toBe('x'.repeat(40));
  });

  it('rejects cross-origin, query-bearing, oversized and nested data paths before forwarding', async () => {
    const forward = vi.fn(async (_request: Request) => Response.json({ result: [] }));
    vi.stubGlobal('fetch', forward);
    const send = (path: string, init: RequestInit) => worker.fetch(new Request(`https://matrix.page${path}`, { method: 'POST', ...init }), env);
    expect((await send('/tasks-lab/data', { headers: { origin: 'https://evil.example' }, body: '{}' })).status).toBe(404);
    expect((await send('/tasks-lab/data', { body: '{}' })).status).toBe(404);
    expect((await send('/tasks-lab/data?table=x', { headers: { origin: 'https://matrix.page' }, body: '{}' })).status).toBe(400);
    expect((await send('/tasks-lab/data/extra', { headers: { origin: 'https://matrix.page' }, body: '{}' })).status).toBe(404);
    expect((await send('/tasks-lab/data', { headers: { origin: 'https://matrix.page' }, body: 'x'.repeat(64 * 1024 + 1) })).status).toBe(413);
    expect(forward).not.toHaveBeenCalled();
  });
});
