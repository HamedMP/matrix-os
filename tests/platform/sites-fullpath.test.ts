import { afterEach, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { Kysely } from 'kysely';
import { KyselyPGlite } from 'kysely-pglite';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { insertUserMachine } from '../../packages/platform/src/db.js';
import { createSitePublicRoutes } from '../../packages/platform/src/sites/public-routes.js';
import { createSiteSubmitRoutes } from '../../packages/gateway/src/sites/submit-routes.js';
import { createSiteRoutes } from '../../packages/gateway/src/sites/routes.js';
import { markAuthContextReady, setPlatformVerifiedPrincipal } from '../../packages/gateway/src/request-principal.js';
import { SiteSubmissionRepository } from '../../packages/gateway/src/sites/submission-repository.js';
import { buildLaunchSite } from '../helpers/sites-launch-fixture.js';
import { createSiteManagementRoutes } from '../../packages/platform/src/sites/management-routes.js';
import { createSitePlatformClient } from '../../packages/gateway/src/sites/platform-client.js';
import { buildPlatformSyncVerificationToken } from '../../packages/platform/src/platform-token.js';
import { siteBuildFixture } from '../gateway/site-build-fixture.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse())
    await close(); });
it('builds a React launch app, deploys it, saves an anonymous RSVP in owner Postgres, and revokes every public path', async () => {
    const bundle = await buildLaunchSite();
    cleanup.push(bundle.cleanup);
    const { db } = await createTestPlatformDb();
    cleanup.push(() => destroyTestPlatformDb(db));
    const ownerInstance = await KyselyPGlite.create();
    const ownerDb = new Kysely<any>({ dialect: ownerInstance.dialect });
    cleanup.push(() => ownerDb.destroy());
    const submissions = new SiteSubmissionRepository(ownerDb);
    await submissions.bootstrap();
    const objects = new Map<string, Uint8Array>();
    const service = createSitesService({ db, storage: {
            async putObject(key, bytes) { objects.set(key, bytes as Uint8Array); return {}; },
            async getObject(key) { const bytes = objects.get(key); return { body: bytes ? new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) : null }; },
            async deleteObject(key) { objects.delete(key); },
        } });
    const owner = { ownerId: 'launch-owner', machineId: 'launch-runtime', appSlug: 'launch' };
    await insertUserMachine(db, { machineId: owner.machineId, clerkUserId: owner.ownerId, handle: 'launch-owner', status: 'running', provisionedAt: new Date().toISOString() });
    const first = await service.deploy(owner, { ...bundle.deployment, slug: 'matrix-launch' });
    const gateway = createSiteSubmitRoutes({ serviceSecret: 'fixture-service-secret', submissions });
    const publicApp = createSitePublicRoutes({ service, edgeSecret: 'verified-edge-proof-secret-1234567890', submit: async (site, _trx, formId, input) => {
            const raw = JSON.stringify({ siteId: site.id, appSlug: site.appSlug, versionId: site.activeVersion, config: site.config, formId, ...input });
            const stamp = String(Date.now());
            const response = await gateway.request(`/api/internal/sites/${site.id}/submit`, { method: 'POST', headers: {
                    'content-type': 'application/json', 'x-matrix-site-timestamp': stamp,
                    'x-matrix-site-signature': createHmac('sha256', 'fixture-service-secret').update(`${stamp}.${raw}`).digest('hex'),
                }, body: raw });
            if (!response.ok)
                throw Error('Fixture submission failed');
            return { accepted: true };
        } });
    const page = await publicApp.request('/matrix-launch', { headers: { 'x-matrix-sites-edge': 'verified-edge-proof-secret-1234567890' } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"');
    const frame = await publicApp.request(`/${first.id}/frame`, { headers: { 'x-matrix-sites-edge': 'verified-edge-proof-secret-1234567890' } });
    expect(frame.status).toBe(200);
    const html = await frame.text();
    expect(html).toContain('MatrixOS');
    expect(html).toContain('type="module"');
    const fields = { name: 'Launch visitor', email: 'visitor@example.com', guests: 2 };
    const post = (extra = {}) => publicApp.request(`/${first.id}/forms/rsvp`, { method: 'POST', headers: { 'x-matrix-sites-edge': 'verified-edge-proof-secret-1234567890', 'content-type': 'application/json' }, body: JSON.stringify({ fields: { ...fields, ...extra }, idempotencyKey: 'launch-rsvp-request-0001' }) });
    expect((await post({ ownerId: 'other' })).status).toBe(400);
    expect(await (await post()).json()).toEqual({ accepted: true });
    expect((await post()).status).toBe(200);
    const ownerApi = (principal: string) => {
        const app = new Hono();
        app.use('*', async (c, next) => { markAuthContextReady(c); setPlatformVerifiedPrincipal(c, principal); await next(); });
        app.route('/', createSiteRoutes({ homePath: '/fixture', ownerIds: [owner.ownerId], submissions, platform: { request: async () => service.get(owner) } }));
        return app;
    };
    expect((await ownerApi('collaborator').request('/api/apps/launch/site/submissions')).status).toBe(403);
    const saved = await (await ownerApi(owner.ownerId).request('/api/apps/launch/site/submissions')).json();
    expect(saved.submissions).toHaveLength(1);
    expect(saved.submissions[0].fields).toEqual(fields);
    const exportResult = await (await ownerApi(owner.ownerId).request('/api/apps/launch/site/submissions/export')).json();
    expect(exportResult.submissions).toEqual(saved.submissions);
    const second = await service.deploy(owner, { ...bundle.deployment, baseRevision: first.revision });
    const rolled = await service.rollback(owner, first.activeVersion!, second.revision);
    expect(rolled.id).toBe(first.id);
    expect((await submissions.list(first.id, 'launch', 50, null)).items).toHaveLength(1);
    await service.unpublish(owner, rolled.revision);
    for (const path of ['/matrix-launch', `/${first.id}`, `/${first.id}/frame`, `/${first.id}/assets/${first.activeVersion}/index.html`, `/${first.id}/assets/${second.activeVersion}/index.html`]) {
        expect((await publicApp.request(path, { headers: { 'x-matrix-sites-edge': 'verified-edge-proof-secret-1234567890' } })).status).toBe(404);
    }
    expect((await post()).status).toBe(404);
    const restartedRepository = new SiteSubmissionRepository(ownerDb);
    expect((await restartedRepository.list(first.id, 'launch', 50, null)).items[0]?.fields).toEqual(fields);
    const deleted = await ownerApi(owner.ownerId).request(`/api/apps/launch/site/submissions/${saved.submissions[0].id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect((await restartedRepository.list(first.id, 'launch', 50, null)).items).toHaveLength(0);
}, 60000);


it('carries the remaining Gateway publication deadline into actual Platform activation', async () => {
 const home = await mkdtemp(join(tmpdir(),'sites-deadline-fullpath-'));
 cleanup.push(() => rm(home,{recursive:true,force:true}));
 const dir = join(home,'apps/event'); await mkdir(join(dir,'dist'),{recursive:true});
 await writeFile(join(dir,'matrix.json'), JSON.stringify({name:'Event',slug:'event',version:'1.0.0',runtime:'vite',runtimeVersion:'1.0.0',build:{command:'pnpm build',output:'dist'}}));
 await writeFile(join(dir,'dist/index.html'),'<html>Deadline</html>');
 const {db} = await createTestPlatformDb(); cleanup.push(() => destroyTestPlatformDb(db));
 const machineId = '1c3a6c9d-dccd-427a-b787-c9af00c14cdb', secret = 'deadline-secret'.repeat(4);
 await insertUserMachine(db,{machineId,clerkUserId:'deadline-owner',handle:'deadline-owner',status:'running',provisionedAt:new Date().toISOString()});
 const started = Date.now(), objects = new Map<string,unknown>();
 vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(started);
 const service = createSitesService({db,storage:{async putObject(key,bytes){objects.set(key,bytes);vi.setSystemTime(started+271000);return {};},async getObject(){return {body:null};},async deleteObject(key){objects.delete(key);}}});
 const platform = new Hono(); platform.route('/internal/containers/:handle/sites',createSiteManagementRoutes({db,platformSecret:secret,service}));
 vi.stubGlobal('fetch',vi.fn((url,init)=>platform.request(String(url),init)));
 try {
  const client = createSitePlatformClient({url:'https://platform.example',token:buildPlatformSyncVerificationToken({handle:'deadline-owner',machineId,runtimeSlot:'primary'},secret),handle:'deadline-owner',runtimeSlot:'primary'});
  const gateway = new Hono(); gateway.use('*',async(c,next)=>{markAuthContextReady(c);setPlatformVerifiedPrincipal(c,'deadline-owner');await next();});
  gateway.route('/',createSiteRoutes({homePath:home,ownerIds:['deadline-owner'],platform:client,submissions:null,build:siteBuildFixture({build:async()=>{vi.setSystemTime(started+265000);return {ok:true};}})}));
  const response = await gateway.request('/api/apps/event/site',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Event',reviewedConfig:{data:{},forms:[]}})});
  expect(response.status).toBe(503);
  const pending = await service.get({ownerId:'deadline-owner',machineId,appSlug:'event'});
  expect(pending).toMatchObject({status:'unpublished',activeVersion:null,versions:[]});
  expect(await service.resolve(pending!.id)).toBeNull();
  expect(objects.size).toBe(0);
 } finally {vi.unstubAllGlobals();vi.useRealTimers();}
});
