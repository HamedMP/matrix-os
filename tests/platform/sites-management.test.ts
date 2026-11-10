import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { buildPlatformVerificationToken, buildPlatformSyncVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { createSiteManagementRoutes } from '../../packages/platform/src/sites/management-routes.js';
import { randomUUID } from 'node:crypto';
import { SITE_MANAGEMENT_CONTRACT_VERSION, SITE_MANAGEMENT_CONTRACT_VERSION_HEADER } from '@matrix-os/contracts';
let db: PlatformDB;
let app: Hono;
const secret = 's'.repeat(40);
const identity={machineId:'b8167260-fcde-4459-b8c2-9f99441778ba',handle:'launch',runtimeSlot:'primary'};
const token=buildPlatformSyncVerificationToken(identity,secret,2);
beforeAll(async () => {
    db = (await createTestPlatformDb()).db;
    await insertUserMachine(db, { machineId: 'b8167260-fcde-4459-b8c2-9f99441778ba', clerkUserId: 'user_launch', handle: 'launch', runtimeTokenEpoch:2,status: 'running', provisionedAt: new Date().toISOString() });
    await insertUserMachine(db, { machineId: '7f6a8164-845c-4960-bc65-036d66592db9', clerkUserId: 'user_preview', handle: 'pr-551', runtimeSlot: 'pr-551', provisioningClass: 'preview', status: 'running', provisionedAt: new Date().toISOString() });
    app = new Hono();
    app.route('/internal/containers/:handle/sites', createSiteManagementRoutes({ db, platformSecret: secret, service: createSitesService({ db }) }));
});
afterAll(async () => { await destroyTestPlatformDb(db); });
it('derives customer owner from verified machine and rejects preview credentials', async () => {
    const url = '/internal/containers/launch/sites/event?runtimeSlot=primary';
    expect((await app.request(url)).status).toBe(401);
    expect((await app.request(url, { headers: { authorization: token } })).status).toBe(401);
    const valid = await app.request(url, { headers: { authorization: `Bearer ${token}` } });
    expect(valid.status).toBe(404);
    expect(await valid.json()).toEqual({ error: 'Site unavailable' });
    expect((await app.request('/internal/containers/pr-551/sites/event?runtimeSlot=pr-551', { headers: { authorization: `Bearer ${buildPlatformSyncVerificationToken({handle:'pr-551',machineId:'7f6a8164-845c-4960-bc65-036d66592db9',runtimeSlot:'pr-551'},secret)}` } })).status).toBe(401);
});
it('fails closed when dedicated asset storage is not configured', async () => {
    const response = await app.request('/internal/containers/launch/sites/event?runtimeSlot=primary', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(503);
});

it('preserves the legacy site response unless the gateway negotiates access mode', async () => {
 const siteId=randomUUID();
 await db.executor.insertInto('public_sites').values({id:siteId,owner_id:'user_launch',machine_id:identity.machineId,app_slug:'legacy-contract',title:'Legacy',description:'',slug:null,revision:1,status:'published',access_mode:'private_link',active_version:null,created_at:new Date().toISOString()}).execute();
 const url='/internal/containers/launch/sites/legacy-contract?runtimeSlot=primary';
 const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};

 const legacyGet=await (await app.request(url,{headers})).json() as Record<string,unknown>;
 expect(legacyGet).not.toHaveProperty('accessMode');
 const legacyPatch=await (await app.request(url,{method:'PATCH',headers,body:JSON.stringify({title:'Legacy updated',baseRevision:1})})).json() as Record<string,unknown>;
 expect(legacyPatch).not.toHaveProperty('accessMode');

 const unsafePatch=await app.request(url,{method:'PATCH',headers,body:JSON.stringify({title:'Unsafe update',accessMode:'public',baseRevision:2})});
 expect(unsafePatch.status).toBe(400);

 const current=await (await app.request(url,{headers:{...headers,[SITE_MANAGEMENT_CONTRACT_VERSION_HEADER]:SITE_MANAGEMENT_CONTRACT_VERSION}})).json() as Record<string,unknown>;
 expect(current).toMatchObject({title:'Legacy updated',accessMode:'private_link',revision:2});
});

it('preserves legacy access-link listings unless the gateway negotiates pagination',async()=>{
 const siteId=randomUUID();
 await db.executor.insertInto('public_sites').values({id:siteId,owner_id:'user_launch',machine_id:identity.machineId,app_slug:'private-event',title:'Private event',description:'',slug:null,revision:1,status:'published',access_mode:'private_link',active_version:null,created_at:new Date().toISOString()}).execute();
 const url='/internal/containers/launch/sites/private-event/access-links?runtimeSlot=primary';
 const listUrl=`${url}&limit=50`;
 const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
 expect(await (await app.request(listUrl,{headers})).json()).toEqual({links:[]});
 const created=await app.request(url,{method:'POST',headers,body:JSON.stringify({baseRevision:1})});
 expect(created.status).toBe(200);
 const value=await created.json() as {link:{id:string};url:string};
 expect(value.url).toMatch(new RegExp(`^https://matrix\\.page/${siteId}#access=`));
 const listed=await (await app.request(listUrl,{headers})).json();
 expect(listed).toEqual({links:[expect.objectContaining({id:value.link.id,status:'unclaimed'})]});
 expect(JSON.stringify(listed)).not.toContain('#access=');
 expect(await (await app.request(listUrl,{headers:{...headers,[SITE_MANAGEMENT_CONTRACT_VERSION_HEADER]:SITE_MANAGEMENT_CONTRACT_VERSION}})).json()).toEqual({links:[expect.objectContaining({id:value.link.id,status:'unclaimed'})],nextCursor:null});
 expect((await app.request(`${url.replace('?runtimeSlot=primary','')}/${value.link.id}?runtimeSlot=primary`,{method:'DELETE',headers})).status).toBe(200);
 expect(await (await app.request(listUrl,{headers})).json()).toEqual({links:[]});
});

it('rejects legacy handle credentials, different machines, different slots and old token epochs',async()=>{
 const url='/internal/containers/launch/sites/event?runtimeSlot=primary';
 const wrong=[buildPlatformVerificationToken('launch',secret),
  buildPlatformSyncVerificationToken({...identity,machineId:'bf8f0983-89f7-4fae-9550-c692d8daeb9c'},secret,2),
  buildPlatformSyncVerificationToken({...identity,runtimeSlot:'other'},secret,2),
  buildPlatformSyncVerificationToken(identity,secret,1)];
 for(const credential of wrong)expect((await app.request(url,{headers:{authorization:`Bearer ${credential}`}})).status).toBe(401);
});

it.each(['expired', 'caller-aborted'] as const)('never activates %s publication during the platform upload', async mode => {
 const started = new Date('2026-10-16T00:00:00Z').getTime();
 vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(started);
 const caller = new AbortController();
 const objects = new Map<string, unknown>();
 const service = createSitesService({ db, storage: {
  async putObject(key, bytes) { objects.set(key, bytes); if (mode === 'expired') vi.setSystemTime(started + 6000); else caller.abort(); return {}; },
  async getObject() { return { body: null }; }, async deleteObject(key) { objects.delete(key); },
 } });
 const platform = new Hono(); platform.route('/internal/containers/:handle/sites', createSiteManagementRoutes({ db, platformSecret: secret, service }));
 try {
  const response = await platform.request('/internal/containers/launch/sites/deadline?runtimeSlot=primary', {
   method: 'POST', signal: caller.signal,
   headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-matrix-site-deadline': String(started + 5000) },
   body: JSON.stringify({ title: 'Deadline', slug: 'deadline-app', config: {}, files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('Deadline').toString('base64') }] }),
  });
  expect(response.status).toBe(503);
  const pending = await service.get({ ownerId: 'user_launch', machineId: identity.machineId, appSlug: 'deadline' });
  expect(pending).toMatchObject({ status: 'unpublished', activeVersion: null, versions: [] });
  expect(await service.resolve(pending!.id)).toBeNull();
  expect(objects.size).toBe(0);
 } finally { vi.useRealTimers(); }
});

it.each(['NaN', '-1', '1.5', '1e12', '9999999999999999'])('rejects an invalid internal publication deadline %s', async deadline => {
 const response = await app.request('/internal/containers/launch/sites/event?runtimeSlot=primary', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-matrix-site-deadline': deadline }, body: '{}' });
 expect(response.status).toBe(400);
});
