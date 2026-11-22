import { afterEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'kysely';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createTestPGlite } from '../helpers/pglite-test-helper.js';
import { insertUserMachine } from '../../packages/platform/src/db.js';
import { buildPlatformSyncVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { createSitePublicRoutes } from '../../packages/platform/src/sites/public-routes.js';
import { createSiteSubmissionTransport } from '../../packages/platform/src/sites/submission-transport.js';
import { createSiteDataTransport } from '../../packages/platform/src/sites/data-transport.js';
import { createAppDb } from '../../packages/gateway/src/app-db.js';
import { createAppRegistry } from '../../packages/gateway/src/app-db-registry.js';
import { SitePublicDataRepository } from '../../packages/gateway/src/sites/public-data-repository.js';
import { createSitePublicDataRoutes } from '../../packages/gateway/src/sites/public-data-routes.js';
import worker from '../../packages/edge-router/src/sites.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const close of cleanup.splice(0).reverse()) await close();
});

it('reads owner data through the Worker and blocks visitor edits before forwarding', async () => {
  const identity = { handle: 'tasks-owner', machineId: 'd3346b7a-3c41-47d5-b0c1-4209aef7b00c', runtimeSlot: 'primary' };
  const platformSecret = 'sites-scoped-platform-secret-123456789';
  const edgeSecret = 'e'.repeat(40);
  const { db } = await createTestPlatformDb();
  cleanup.push(() => destroyTestPlatformDb(db));
  await insertUserMachine(db, { ...identity, clerkUserId: 'user_tasks_owner', runtimeTokenEpoch: 4, status: 'running', publicIPv4: '93.184.216.34', provisionedAt: new Date().toISOString() });
  const service = createSitesService({ db, storage: { async putObject() { return {}; }, async getObject() { return { body: null }; } } });
  const site = await service.deploy({ ownerId: 'user_tasks_owner', machineId: identity.machineId, appSlug: 'tasks-lab' },
    { title: 'Tasks', config: {}, files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('Tasks').toString('base64') }] });

  const owner = await createTestPGlite();
  const ownerDb = createAppDb({ dialect: owner.dialect });
  cleanup.push(() => ownerDb.db.destroy());
  await ownerDb.db.bootstrap();
  const registry = createAppRegistry(ownerDb.db, ownerDb.kysely);
  await registry.register({ slug: 'tasks-lab', name: 'Tasks', tables: { tasks: { columns: { title: 'text' } } } });
  await registry.register({ slug: 'private-notes', name: 'Notes', tables: { notes: { columns: { body: 'text' } } } });
  await SitePublicDataRepository.bootstrap(ownerDb.kysely);
  await sql`INSERT INTO "tasks-lab".tasks (title) VALUES ('Owner task')`.execute(ownerDb.kysely);
  await sql`INSERT INTO public._kv (app, key, value) VALUES ('tasks-lab', 'theme', 'light')`.execute(ownerDb.kysely);
  const gateway = new Hono();
  gateway.route('/', createSitePublicDataRoutes({
    serviceSecret: buildPlatformSyncVerificationToken(identity, platformSecret, 4),
    repository: new SitePublicDataRepository(ownerDb.kysely, { resolveApp: (slug) => registry.get(slug) }),
    env: {},
  }));
  const platform = new Hono();
  platform.route('/public/sites', createSitePublicRoutes({ service, edgeSecret, submit: createSiteSubmissionTransport({ platformSecret }),
    data: { transport: createSiteDataTransport({ db, platformSecret }), env: {} } }));

  const forwardToGateway = vi.fn((request: Request) => gateway.request(new URL(request.url).pathname, request));
  vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === 'https://platform.example.com') return platform.request(url.pathname, { method: request.method, headers: request.headers, body: await request.arrayBuffer() });
    if (url.origin === 'https://93.184.216.34:443' || url.hostname === '93.184.216.34') return forwardToGateway(request);
    throw new TypeError('unexpected upstream');
  });
  const env = { SITES_PLATFORM_ORIGIN: 'https://platform.example.com', SITES_EDGE_SECRET: edgeSecret };
  const visit = (body: unknown) => worker.fetch(new Request(`https://matrix.page/${site.id}/data`, {
    method: 'POST', headers: { origin: 'https://matrix.page', 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.50' }, body: JSON.stringify(body),
  }), env);

  const listed = await visit({ kind: 'db', action: { action: 'find', table: 'tasks' } });
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({ result: [expect.objectContaining({ title: 'Owner task' })] });
  const key = await visit({ kind: 'kvRead', key: 'theme' });
  expect(await key.json()).toEqual({ result: { value: 'light' } });
  expect((await visit({ kind: 'db', action: { action: 'find', table: 'notes' } })).status).toBe(400);

  forwardToGateway.mockClear();
  for (const write of [
    { kind: 'db', action: { action: 'insert', table: 'tasks', data: { title: 'From a visitor' } } },
    { kind: 'kvWrite', key: 'theme', value: 'dark' },
  ]) {
    const denied = await visit(write);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'Public app data is read-only' });
  }
  expect(forwardToGateway).not.toHaveBeenCalled();
  expect((await sql`SELECT title FROM "tasks-lab".tasks`.execute(ownerDb.kysely)).rows).toEqual([{ title: 'Owner task' }]);
  expect((await sql`SELECT value FROM public._kv WHERE app = 'tasks-lab' AND key = 'theme'`.execute(ownerDb.kysely)).rows).toEqual([{ value: 'light' }]);
  expect((await sql`SELECT id FROM public._site_visitor_writes`.execute(ownerDb.kysely)).rows).toEqual([]);
});
