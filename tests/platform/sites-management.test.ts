import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { buildPlatformVerificationToken, buildPlatformSyncVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { createSiteManagementRoutes } from '../../packages/platform/src/sites/management-routes.js';
import { registerSiteRoutes } from '../../packages/platform/src/sites/registration.js';
import { randomUUID } from 'node:crypto';
import { SITE_ALLOWLIST_READINESS_VERSION, SITE_MANAGEMENT_CONTRACT_VERSION, SITE_MANAGEMENT_CONTRACT_VERSION_HEADER } from '@matrix-os/contracts';
import { seedLegacyAccessLink } from './site-legacy-access-links.js';
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

it('keeps email capability fields out of version 2 gateway responses', async () => {
 const siteId=randomUUID();
 await db.executor.insertInto('public_sites').values({id:siteId,owner_id:'user_launch',machine_id:identity.machineId,app_slug:'contract-upgrade',title:'Upgrade',description:'',slug:null,revision:0,status:'published',access_mode:'private_email',active_version:null,created_at:new Date().toISOString()}).execute();
 const versioned=new Hono();
 versioned.route('/internal/containers/:handle/sites',createSiteManagementRoutes({db,platformSecret:secret,service:createSitesService({db,emailCapability:async()=>true})}));
 const url='/internal/containers/launch/sites/contract-upgrade?runtimeSlot=primary';
 const headers={authorization:`Bearer ${token}`};
 const previous=await (await versioned.request(url,{headers:{...headers,[SITE_MANAGEMENT_CONTRACT_VERSION_HEADER]:'2'}})).json() as Record<string,unknown>;
 expect(previous.accessMode).toBe('private_email');
 expect(previous).not.toHaveProperty('capabilities');
 const current=await (await versioned.request(url,{headers:{...headers,[SITE_MANAGEMENT_CONTRACT_VERSION_HEADER]:'3'}})).json() as Record<string,unknown>;
 expect(current).toMatchObject({accessMode:'private_email',capabilities:{privateEmailInvitations:true}});
});

it('registers only with concrete dependencies and advertises email readiness as false by default', async () => {
 const missing = { db: undefined, platformSecret: secret } as unknown as Parameters<typeof registerSiteRoutes>[1];
 expect(() => registerSiteRoutes(new Hono(), missing)).toThrow();
 expect(() => registerSiteRoutes(new Hono(), { db, platformSecret: '' })).toThrow();
 const siteId = randomUUID();
 await db.executor.insertInto('public_sites').values({ id: siteId, owner_id: 'user_launch', machine_id: identity.machineId,
  app_slug: 'email-capability', title: 'Email capability', description: '', slug: null, revision: 0,
  status: 'published', access_mode: 'public', active_version: null, created_at: new Date().toISOString() }).execute();
 const registered = new Hono();
 registerSiteRoutes(registered, { db, platformSecret: secret, edgeSecret: 'e'.repeat(40), env: { MATRIX_PAGE_EMAIL_INVITATIONS_ENABLED: 'true' } });
 const response = await registered.request('/internal/containers/launch/sites/email-capability?runtimeSlot=primary', {
  headers: { authorization: `Bearer ${token}`, [SITE_MANAGEMENT_CONTRACT_VERSION_HEADER]: SITE_MANAGEMENT_CONTRACT_VERSION },
 });
 expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({ capabilities: { privateEmailInvitations: false } });
});

it('lists and revokes legacy access links but refuses to create new ones for any client contract',async()=>{
 const siteId=randomUUID();
 await db.executor.insertInto('public_sites').values({id:siteId,owner_id:'user_launch',machine_id:identity.machineId,app_slug:'private-event',title:'Private event',description:'',slug:null,revision:1,status:'published',access_mode:'private_link',active_version:null,created_at:new Date().toISOString()}).execute();
 const url='/internal/containers/launch/sites/private-event/access-links?runtimeSlot=primary';
 const listUrl=`${url}&limit=50`;
 const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
 const currentHeaders={...headers,[SITE_MANAGEMENT_CONTRACT_VERSION_HEADER]:SITE_MANAGEMENT_CONTRACT_VERSION};
 expect(await (await app.request(listUrl,{headers})).json()).toEqual({links:[]});
 for(const requestHeaders of [headers,currentHeaders]){
  const created=await app.request(url,{method:'POST',headers:requestHeaders,body:JSON.stringify({baseRevision:1})});
  expect(created.status).toBe(410);
  expect(await created.json()).toEqual({error:'One-time links are no longer available'});
 }
 expect(await (await app.request(listUrl,{headers})).json()).toEqual({links:[]});
 const seeded=await seedLegacyAccessLink(db,siteId);
 const listed=await (await app.request(listUrl,{headers})).json();
 expect(listed).toEqual({links:[expect.objectContaining({id:seeded.linkId,status:'unclaimed'})]});
 expect(JSON.stringify(listed)).not.toContain(seeded.secret);
 expect(await (await app.request(listUrl,{headers:currentHeaders})).json()).toEqual({links:[expect.objectContaining({id:seeded.linkId,status:'unclaimed'})],nextCursor:null});
 expect((await app.request(`${url.replace('?runtimeSlot=primary','')}/${seeded.linkId}?runtimeSlot=primary`,{method:'DELETE',headers})).status).toBe(200);
 expect(await (await app.request(listUrl,{headers})).json()).toEqual({links:[]});
});
it('serves bounded email invitation and audit endpoints only to the exact owner machine',async()=>{
 const siteId=randomUUID();
 await db.executor.insertInto('public_sites').values({id:siteId,owner_id:'user_launch',machine_id:identity.machineId,
  app_slug:'email-event',title:'Email event',description:'',slug:null,revision:1,status:'published',
  access_mode:'private_email',active_version:null,created_at:new Date().toISOString()}).execute();
 const enabled=new Hono();enabled.route('/internal/containers/:handle/sites',createSiteManagementRoutes({db,platformSecret:secret,
  service:createSitesService({db}),emailEnabled:async()=>true}));
 const url='/internal/containers/launch/sites/email-event/invitations?runtimeSlot=primary';
 const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
 expect((await enabled.request(url,{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({baseRevision:1,emailAddresses:['person@example.com']})})).status).toBe(401);
 const created=await enabled.request(url,{method:'POST',headers,
  body:JSON.stringify({baseRevision:1,emailAddresses:['person@example.com']})});
 expect(created.status).toBe(200);
 const result=await created.json() as {results:Array<{invitation:{id:string;revision:number}}>;siteRevision:number};
 expect(result.results[0]).toMatchObject({outcome:'queued'});
 const invitationId=result.results[0]!.invitation.id;
 expect((await enabled.request(url,{headers})).status).toBe(200);
 expect((await enabled.request(url+'&limit=0',{headers})).status).toBe(400);
 expect((await enabled.request(url,{method:'POST',headers,body:'x'.repeat(33*1024)})).status).toBe(413);
 const revoked=await enabled.request(`${url.replace('?runtimeSlot=primary','')}/${invitationId}?runtimeSlot=primary`,{
  method:'DELETE',headers,body:JSON.stringify({baseRevision:result.siteRevision,invitationRevision:0})});
 expect(revoked.status).toBe(200);
 const audit=await enabled.request('/internal/containers/launch/sites/email-event/invitations/audit?runtimeSlot=primary',{headers});
 expect(audit.status).toBe(200);
 expect((await audit.json() as {events:Array<{type:string}>}).events.map(event=>event.type))
  .toEqual(expect.arrayContaining(['invitation_created','invitation_revoked']));
});

it('maps a switch into one-time links to a generic gone response while legacy private sites stay editable',async()=>{
 const publicId=randomUUID();
 const privateId=randomUUID();
 await db.executor.insertInto('public_sites').values([
  {id:publicId,owner_id:'user_launch',machine_id:identity.machineId,app_slug:'public-switch',title:'Public',description:'',slug:null,revision:1,status:'published',access_mode:'public',active_version:null,created_at:new Date().toISOString()},
  {id:privateId,owner_id:'user_launch',machine_id:identity.machineId,app_slug:'private-keep',title:'Private',description:'',slug:null,revision:1,status:'published',access_mode:'private_link',active_version:null,created_at:new Date().toISOString()},
 ]).execute();
 const headers={authorization:`Bearer ${token}`,'content-type':'application/json',[SITE_MANAGEMENT_CONTRACT_VERSION_HEADER]:SITE_MANAGEMENT_CONTRACT_VERSION};
 const refused=await app.request('/internal/containers/launch/sites/public-switch?runtimeSlot=primary',{method:'PATCH',headers,body:JSON.stringify({accessMode:'private_link',baseRevision:1})});
 expect(refused.status).toBe(410);
 expect(await refused.json()).toEqual({error:'One-time links are no longer available'});
 const kept=await app.request('/internal/containers/launch/sites/private-keep?runtimeSlot=primary',{method:'PATCH',headers,body:JSON.stringify({title:'Private renamed',accessMode:'private_link',baseRevision:1})});
 expect(kept.status).toBe(200);
 expect(await kept.json()).toMatchObject({title:'Private renamed',accessMode:'private_link',revision:2});
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

it('advertises disabled invitation readiness before publication without creating a site', async () => {
 const url='/internal/containers/launch/sites/not-published/email-invitation-capabilities?runtimeSlot=primary';
 expect((await app.request(url)).status).toBe(401);
 const response=await app.request(url,{headers:{authorization:'Bearer '+token,[SITE_MANAGEMENT_CONTRACT_VERSION_HEADER]:SITE_ALLOWLIST_READINESS_VERSION}});
 expect(response.status).toBe(200);
 expect(response.headers.get('cache-control')).toBe('no-store');
 expect(await response.json()).toEqual({privateEmailInvitations:false,emailDelivery:'none'});
 expect(await db.executor.selectFrom('public_sites').select('id').where('app_slug','=','not-published').execute()).toEqual([]);
});
it('reads readiness through verified machine authority and rejects untrusted query input', async () => {
 const enabled=vi.fn(async()=>true);
 const ready=new Hono().route('/internal/containers/:handle/sites',createSiteManagementRoutes({db,platformSecret:secret,service:createSitesService({db}),emailEnabled:enabled}));
 const url='/internal/containers/launch/sites/not-published/email-invitation-capabilities?runtimeSlot=primary';
 const current={authorization:'Bearer '+token,[SITE_MANAGEMENT_CONTRACT_VERSION_HEADER]:SITE_ALLOWLIST_READINESS_VERSION};
 expect((await ready.request(url)).status).toBe(401);
 expect(enabled).not.toHaveBeenCalled();
 const response=await ready.request(url,{headers:current});
 expect(await response.json()).toEqual({privateEmailInvitations:true,emailDelivery:'none'});
 expect((await ready.request(url+'&enabled=true',{headers:current})).status).toBe(400);
});
it('keeps allowlist readiness off for gateways that cannot show allowlist copy', async () => {
 const ready=new Hono().route('/internal/containers/:handle/sites',createSiteManagementRoutes({db,platformSecret:secret,service:createSitesService({db}),emailEnabled:async()=>true}));
 const url='/internal/containers/launch/sites/not-published/email-invitation-capabilities?runtimeSlot=primary';
 for(const version of [undefined,'2','3']){
  const response=await ready.request(url,{headers:{authorization:'Bearer '+token,...(version?{[SITE_MANAGEMENT_CONTRACT_VERSION_HEADER]:version}:{})}});
  expect(await response.json(),version).toEqual({privateEmailInvitations:false});
 }
});
it('keeps ordinary Sites operations on contract 3 so previous Platforms keep publishing', () => {
 // A v4 header on publish/edit would be rejected by a Platform that predates allowlist mode.
 expect(SITE_MANAGEMENT_CONTRACT_VERSION).toBe('3');
 expect(SITE_ALLOWLIST_READINESS_VERSION).toBe('4');
});
