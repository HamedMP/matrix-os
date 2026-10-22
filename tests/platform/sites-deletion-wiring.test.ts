import { resolveSitesObjectStorage } from '../../packages/platform/src/sites/storage-config.js';
import { createR2Client } from '../../packages/platform/src/r2-client.js';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertUserMachine, updateUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createConfiguredAccountDeletionRuntime } from '../../packages/platform/src/account-deletion/wiring.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
const objects = vi.hoisted(() => new Map<string, Uint8Array>());
const sitesStore = vi.hoisted(() => ({
    listObjects: vi.fn(async (prefix: string) => ({ keys: [...objects.keys()].filter(key => key.startsWith(prefix)), nextCursor: null })),
    deleteObject: vi.fn(async (key: string) => { objects.delete(key); }), abortOwnerMultipartUploads: vi.fn(async () => { }), destroy: vi.fn(),
    getPresignedGetUrl:vi.fn(async(key:string)=>'https://sites.example.test/'+key),
}));
const syncStore = vi.hoisted(() => ({ listObjects: vi.fn(async () => ({ keys: [], nextCursor: null })), deleteObject: vi.fn(), abortOwnerMultipartUploads: vi.fn(), destroy: vi.fn(),
    getPresignedGetUrl:vi.fn(async(key:string)=>'https://sync.example.test/'+key) }));
const configured = vi.hoisted(() => vi.fn((config: {
    bucket: string;
}) => config.bucket === 'private-sites' ? sitesStore : syncStore));
vi.mock('../../packages/platform/src/account-deletion/storage.js', async (original) => ({ ...await original<object>(), createAccountDeletionObjectStore: configured }));
vi.mock('../../packages/platform/src/customer-vps-hetzner.js', () => ({ createHetznerClient: () => ({ async listServersByLabel() { return []; }, async getServer() { return null; } }) }));
let db: PlatformDB;
const env = { ACCOUNT_DELETION_CONFIGURED: 'true', ACCOUNT_DELETION_SECRET: 'sites-deletion-wiring-secret-123456', CLERK_SECRET_KEY: 'test', R2_ACCESS_KEY_ID: 'sync-key', R2_SECRET_ACCESS_KEY: 'sync-secret',
    R2_SITES_BUCKET: 'private-sites', R2_SITES_ACCESS_KEY_ID: 'sites-key', R2_SITES_SECRET_ACCESS_KEY: 'sites-secret', R2_SITES_SESSION_TOKEN: 'sites-session', R2_SITES_ENDPOINT: 'https://private-sites.example.test' };
beforeAll(async () => { db = (await createTestPlatformDb()).db;
    await insertUserMachine(db, { machineId: 'test-machine', clerkUserId: 'user_sites_delete_wiring', handle: 'deletion-wiring', status: 'running', provisionedAt: new Date().toISOString() });
});
beforeEach(async () => { objects.clear(); vi.clearAllMocks(); await db.executor.deleteFrom('account_deletion_jobs').execute(); await db.executor.deleteFrom('public_sites').execute(); await db.executor.deleteFrom('public_site_aliases').execute(); });
afterAll(async () => { vi.restoreAllMocks(); await destroyTestPlatformDb(db); });
it('configured deletion revokes site immediately and durably erases dedicated assets and routing', async () => {
    const owner = { ownerId: 'user_sites_delete_wiring', machineId: 'test-machine', appSlug: 'event' };
    const service = createSitesService({ db, env, storage: { async putObject(key, body) { objects.set(key, body as Uint8Array); return {}; }, async getObject() { return { body: null }; } } });
    const site = await service.deploy(owner, { title: 'Event', slug: 'erase-event', config: {}, files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('Event').toString('base64') }] });
    objects.set('sites/owners/user_foreign/keep/index.html', new Uint8Array([1]));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (String(url).includes('organization_memberships'))
            return Response.json({ data: [], total_count: 0 });
        if (String(url).includes('/users/'))
            return init?.method === 'DELETE' ? Response.json({ deleted: true }) : Response.json({ external_accounts: [] });
        throw Error('Unexpected outbound request');
    });
    const customerVpsService = { async delete(machineId: string) {
        // Simulate completed runtime revocation whose sync-upload URLs expired.
        await updateUserMachine(db, machineId, { status: 'deleted', deletedAt: '2020-01-01T00:00:00.000Z' });
        return { machineId, status: 'deleted' as const };
    } } as Parameters<typeof createConfiguredAccountDeletionRuntime>[0]['customerVpsService'];
    const runtime = await createConfiguredAccountDeletionRuntime({ db, env, customerVpsService, backgroundWorkersEnabled: false });
    try {
        expect(configured).toHaveBeenCalledWith(expect.objectContaining({ bucket: 'private-sites', accessKeyId: 'sites-key', secretAccessKey: 'sites-secret', sessionToken: 'sites-session' }));
        await runtime!.service.schedule(owner.ownerId);
        expect(await service.resolve(site.id)).toBeNull();
        await db.executor.updateTable('account_deletion_jobs').set({ due_at: '2020-01-01', next_attempt_at: '2020-01-01' }).execute();
        await runtime!.service.reconcile();
        expect(await runtime!.service.get(owner.ownerId)).toMatchObject({ status: 'completed' });
        expect([...objects.keys()]).toEqual(['sites/owners/user_foreign/keep/index.html']);
        expect(await db.executor.selectFrom('public_site_aliases').selectAll().execute()).toEqual([{slug:'erase-event',site_id:null}]);
        expect(await db.executor.selectFrom('public_site_versions').selectAll().execute()).toEqual([]);
    }
    finally {
        runtime?.stop();
        await runtime?.drain();
        runtime?.close();
    }
    expect(sitesStore.destroy).toHaveBeenCalledOnce();
    expect(syncStore.destroy).toHaveBeenCalledOnce();
});
it('refuses partial or shared dedicated sites credentials before starting cleanup', async () => {
    await expect(createConfiguredAccountDeletionRuntime({ db, env: { ...env, R2_SITES_SECRET_ACCESS_KEY: '' }, backgroundWorkersEnabled: false })).rejects.toThrow('Dedicated sites');
    await expect(createConfiguredAccountDeletionRuntime({ db, env: { ...env, R2_SITES_BUCKET: 'matrixos-sync' }, backgroundWorkersEnabled: false })).rejects.toThrow('Dedicated sites');
});

it('wires dedicated publication assets into the owner export sequence',async()=>{
 objects.set('sites/owners/user_sites_delete_wiring/site/version/index.html',new Uint8Array([1]));
 const runtime=await createConfiguredAccountDeletionRuntime({db,env,backgroundWorkersEnabled:false});
 try{
  const downloads=[];let cursor:string|undefined;
  do{const page=await runtime!.exportData('user_sites_delete_wiring',cursor);downloads.push(...page.downloads);cursor=page.nextCursor??undefined;}while(cursor);
  expect(downloads).toEqual([{name:'sites/site/version/index.html',url:'https://sites.example.test/sites/owners/user_sites_delete_wiring/site/version/index.html'}]);
  expect(sitesStore.getPresignedGetUrl).toHaveBeenCalledOnce();expect(syncStore.getPresignedGetUrl).not.toHaveBeenCalled();
 }finally{runtime?.stop();await runtime?.drain();runtime?.close();}
});

it('signs deletion exports with only the explicit store session token', async () => {
 const actual = await vi.importActual<typeof import('../../packages/platform/src/account-deletion/storage.js')>('../../packages/platform/src/account-deletion/storage.js');
 const store = actual.createAccountDeletionObjectStore({bucket:'private-sites',accessKeyId:'sites-key',secretAccessKey:'sites-secret',sessionToken:'sites-session',endpoint:'https://r2.example.test'});
 try { expect(new URL(await store.getPresignedGetUrl!('synthetic-fixture.txt')).searchParams.get('X-Amz-Security-Token')).toBe('sites-session'); }
 finally { store.destroy?.(); }
});

it('uses the dedicated Sites session through real SDK signing, independent of all other tokens', async () => {
 const config = resolveSitesObjectStorage({...env,R2_SESSION_TOKEN:'sync-session',R2_BUNDLES_SESSION_TOKEN:'bundle-session',S3_SESSION_TOKEN:'s3-session',AWS_SESSION_TOKEN:'ambient'});
 expect(config).toMatchObject({bucket:'private-sites',sessionToken:'sites-session'});
 const client = await createR2Client(config!);
 try { expect(new URL(await client.getPresignedGetUrl('synthetic-fixture.txt')).searchParams.get('X-Amz-Security-Token')).toBe('sites-session'); }
 finally {client.destroy();}
 const permanent=resolveSitesObjectStorage({...env,R2_SITES_SESSION_TOKEN:undefined,R2_SESSION_TOKEN:'sync-session',R2_BUNDLES_SESSION_TOKEN:'bundle-session',AWS_SESSION_TOKEN:'ambient'});
 expect(permanent).not.toHaveProperty('sessionToken');
});
it('rejects configured bucket aliases even when primary or bundle credentials are incomplete', () => {
 for(const unrelated of [{R2_BUCKET:'private-sites'},{S3_BUCKET:'private-sites'},{R2_BUNDLES_BUCKET:'private-sites'},{S3_BUNDLES_BUCKET:'private-sites'},{R2_BUCKET:' private-sites '}]) {
  expect(()=>resolveSitesObjectStorage({...env,R2_ACCESS_KEY_ID:undefined,R2_SECRET_ACCESS_KEY:undefined,R2_BUNDLES_ACCESS_KEY_ID:undefined,R2_BUNDLES_SECRET_ACCESS_KEY:undefined,...unrelated})).toThrow('Dedicated sites');
 }
 expect(()=>resolveSitesObjectStorage({...env,R2_SITES_BUCKET:' matrixos-sync '})).toThrow('Dedicated sites');
});
it('never enables or fills incomplete Sites credentials from another store or ambient session', () => {
 expect(resolveSitesObjectStorage({R2_ACCESS_KEY_ID:'sync-key',R2_SECRET_ACCESS_KEY:'sync-secret',R2_SESSION_TOKEN:'sync-session',AWS_SESSION_TOKEN:'ambient'})).toBeNull();
 for(const config of [{R2_SITES_SESSION_TOKEN:'sites-session'},{...env,R2_SITES_SECRET_ACCESS_KEY:undefined},{...env,R2_SITES_ACCESS_KEY_ID:' '},{...env,R2_SITES_BUCKET:undefined}]) {
  expect(()=>resolveSitesObjectStorage(config)).toThrow('Dedicated sites');
 }
});
it('passes primary and Sites sessions separately to configured deletion stores', async () => {
 const runtime=await createConfiguredAccountDeletionRuntime({db,env:{...env,R2_SESSION_TOKEN:'sync-session',R2_BUNDLES_SESSION_TOKEN:'bundle-session',AWS_SESSION_TOKEN:'ambient'},backgroundWorkersEnabled:false});
 try {
  expect(configured).toHaveBeenCalledWith(expect.objectContaining({accessKeyId:'sync-key',sessionToken:'sync-session'}));
  expect(configured).toHaveBeenCalledWith(expect.objectContaining({bucket:'private-sites',accessKeyId:'sites-key',sessionToken:'sites-session'}));
 } finally {runtime?.stop();await runtime?.drain();runtime?.close();}
});
it('preserves selected S3 family token for primary deletion without borrowing it for Sites', async () => {
 const runtime=await createConfiguredAccountDeletionRuntime({db,env:{...env,S3_ACCESS_KEY_ID:'s3-key',S3_SECRET_ACCESS_KEY:'s3-secret',S3_SESSION_TOKEN:'s3-session',R2_SESSION_TOKEN:'wrong-family'},backgroundWorkersEnabled:false});
 try {
  expect(configured).toHaveBeenCalledWith(expect.objectContaining({accessKeyId:'s3-key',sessionToken:'s3-session'}));
  expect(configured).toHaveBeenCalledWith(expect.objectContaining({bucket:'private-sites',sessionToken:'sites-session'}));
 } finally {runtime?.stop();await runtime?.drain();runtime?.close();}
});
