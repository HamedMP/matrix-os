import { afterAll, beforeAll, expect, it } from 'vitest';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { buildPlatformSyncVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { createSiteManagementRoutes } from '../../packages/platform/src/sites/management-routes.js';

// Outcome: the share popover can tell an owner whether a friendly path is free
// before publishing. Faults detected: reporting the owner's own alias as taken,
// offering a taken or reserved suggestion, or accepting unauthenticated checks.
let db: PlatformDB;
let app: Hono;
const secret = 's'.repeat(40);
const identity = { machineId: 'b8167260-fcde-4459-b8c2-9f99441778ba', handle: 'launch', runtimeSlot: 'primary' };
const otherMachine = '0f3a64fe-6f25-4a8a-9d7b-6b3b57e0c111';
const headers = { authorization: `Bearer ${buildPlatformSyncVerificationToken(identity, secret, 2)}` };
const ownSiteId = randomUUID();
const otherSiteId = randomUUID();

async function insertSite(id: string, ownerId: string, machineId: string, appSlug: string, slug: string | null) {
  await db.executor.insertInto('public_sites').values({ id, owner_id: ownerId, machine_id: machineId, app_slug: appSlug, title: appSlug, description: '', slug, revision: 1, status: 'published', access_mode: 'public', active_version: null, created_at: new Date().toISOString() }).execute();
  if (slug) await db.executor.insertInto('public_site_aliases').values({ slug, site_id: id }).execute();
}

beforeAll(async () => {
  db = (await createTestPlatformDb()).db;
  await insertUserMachine(db, { machineId: identity.machineId, clerkUserId: 'user_launch', handle: 'launch', runtimeTokenEpoch: 2, status: 'running', provisionedAt: new Date().toISOString() });
  await insertUserMachine(db, { machineId: otherMachine, clerkUserId: 'user_other', handle: 'other', status: 'running', provisionedAt: new Date().toISOString() });
  await insertSite(ownSiteId, 'user_launch', identity.machineId, 'sales-crm', 'my-crm');
  await insertSite(otherSiteId, 'user_other', otherMachine, 'crm', 'crm');
  await db.executor.insertInto('public_site_aliases').values({ slug: 'crm-sales-crm', site_id: otherSiteId }).execute();
  app = new Hono();
  app.route('/internal/containers/:handle/sites', createSiteManagementRoutes({ db, platformSecret: secret, service: createSitesService({ db }) }));
});
afterAll(async () => { await destroyTestPlatformDb(db); });

const check = (slug: string, appSlug = 'sales-crm') => app.request(`/internal/containers/launch/sites/${appSlug}/slug-availability?runtimeSlot=primary&slug=${encodeURIComponent(slug)}`, { headers });

it('reports a free path and the owner\'s current path as available', async () => {
  expect(await (await check('launch-party')).json()).toEqual({ status: 'available', suggestions: [] });
  expect(await (await check('my-crm')).json()).toEqual({ status: 'available', suggestions: [] });
});

it('reports another site\'s path as taken and suggests only free alternatives', async () => {
  const response = await check('crm');
  expect(response.status).toBe(200);
  // crm-sales-crm is claimed by another site, so the app hint is skipped.
  expect(await response.json()).toEqual({ status: 'taken', suggestions: ['crm-app', 'crm-2'] });
});

it('reports reserved and malformed paths without a database lookup result', async () => {
  expect(await (await check('admin')).json()).toEqual({ status: 'reserved', suggestions: [] });
  expect(await (await check('a')).json()).toEqual({ status: 'invalid', suggestions: [] });
  expect(await (await check('Bad Path')).json()).toEqual({ status: 'invalid', suggestions: [] });
});

it('requires the machine credential and a bounded slug parameter', async () => {
  expect((await app.request('/internal/containers/launch/sites/sales-crm/slug-availability?runtimeSlot=primary&slug=crm')).status).toBe(401);
  expect((await check('x'.repeat(64))).status).toBe(400);
  expect((await app.request('/internal/containers/launch/sites/sales-crm/slug-availability?runtimeSlot=primary&slug=crm&extra=1', { headers })).status).toBe(400);
});
