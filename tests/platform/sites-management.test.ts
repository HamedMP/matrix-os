import { afterAll, beforeAll, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { buildPlatformVerificationToken, buildPlatformSyncVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { createSiteManagementRoutes } from '../../packages/platform/src/sites/management-routes.js';
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

it('rejects legacy handle credentials, different machines, different slots and old token epochs',async()=>{
 const url='/internal/containers/launch/sites/event?runtimeSlot=primary';
 const wrong=[buildPlatformVerificationToken('launch',secret),
  buildPlatformSyncVerificationToken({...identity,machineId:'bf8f0983-89f7-4fae-9550-c692d8daeb9c'},secret,2),
  buildPlatformSyncVerificationToken({...identity,runtimeSlot:'other'},secret,2),
  buildPlatformSyncVerificationToken(identity,secret,1)];
 for(const credential of wrong)expect((await app.request(url,{headers:{authorization:`Bearer ${credential}`}})).status).toBe(401);
});
