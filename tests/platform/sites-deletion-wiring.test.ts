import { resolveSitesObjectStorage } from '../../packages/platform/src/sites/storage-config.js';
import { createR2Client } from '../../packages/platform/src/r2-client.js';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertUserMachine, updateUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createConfiguredAccountDeletionRuntime } from '../../packages/platform/src/account-deletion/wiring.js';
import { createSitesService } from '../../packages/platform/src/sites/service.js';
import { eraseOwnerPlatformData } from '../../packages/platform/src/account-deletion/cleanup-data.js';
import { siteRecipientKey } from '../../packages/platform/src/sites/email-keys.js';
import { eraseOwnerSites } from '../../packages/platform/src/sites/account-lifecycle.js';
import { randomUUID } from 'node:crypto';
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
it('revokes email invitations and sessions and cancels leased mail before owner asset erasure',async()=>{
 const owner={ownerId:'user_sites_delete_wiring',machineId:'test-machine',appSlug:'event'};
 const service=createSitesService({db,env,emailCapability:async()=>true,storage:{async putObject(){return{};},async getObject(){return{body:null};}}});
 const site=await service.deploy(owner,{title:'Event',accessMode:'private_email',config:{},files:[{path:'index.html',contentType:'text/html',body:Buffer.from('Event').toString('base64')}]});
 const pendingId=randomUUID(),acceptedId=randomUUID(),grantId=randomUUID(),sessionId=randomUUID(),deliveryId=randomUUID(),now=new Date();
 const invitation=(id:string,email:string,state:'pending'|'accepted')=>({id,site_id:site.id,normalized_email:email,display_email:email,generation:'1',
  state,delivery_state:'sending' as const,invited_by_clerk_user_id:owner.ownerId,accepted_clerk_user_id:state==='accepted'?'user_guest':null,
  created_at:now,issued_at:now,expires_at:new Date(now.getTime()+7*86400_000),accepted_at:state==='accepted'?now:null,
  revoked_at:null,state_reason:null,updated_at:now,revision:'0'});
 await db.executor.insertInto('public_site_email_invitations').values([
  invitation(pendingId,'pending@example.test','pending'),invitation(acceptedId,'accepted@example.test','accepted')]).execute();
 await db.executor.insertInto('public_site_viewer_grants').values({id:grantId,site_id:site.id,invitation_id:acceptedId,
  invitation_generation:'1',clerk_user_id:'user_guest',granted_at:now,revoked_at:null,revocation_reason:null}).execute();
 await db.executor.insertInto('public_site_viewer_sessions').values({id:sessionId,site_id:site.id,grant_id:grantId,
  secret_hash:'a'.repeat(64),clerk_session_key:'b'.repeat(64),created_at:now,expires_at:new Date(now.getTime()+7*86400_000),
  last_seen_at:null,revoked_at:null}).execute();
 await db.executor.insertInto('public_site_invitation_deliveries').values({id:deliveryId,invitation_id:pendingId,
  invitation_generation:'1',idempotency_key:randomUUID(),state:'leased',attempts:1,available_at:now,
  lease_token:randomUUID(),lease_until:new Date(now.getTime()+60_000),provider_message_id:null,failure_code:null,
  sent_at:null,created_at:now,updated_at:now}).execute();
 const store={abortOwnerMultipartUploads:vi.fn(),listObjects:vi.fn(async()=>({keys:[],nextCursor:null})),
  deleteObject:vi.fn()};
 await eraseOwnerSites(db,owner.ownerId,store,env);
 const invitations=await db.executor.selectFrom('public_site_email_invitations').selectAll().where('site_id','=',site.id).execute();
 expect(invitations).toHaveLength(2);
 expect(invitations.every(row=>row.state==='revoked'&&row.delivery_state==='suppressed'&&row.state_reason==='owner')).toBe(true);
 expect((await db.executor.selectFrom('public_site_viewer_grants').select('revocation_reason').where('id','=',grantId).executeTakeFirst())?.revocation_reason).toBe('owner_deleted');
 expect((await db.executor.selectFrom('public_site_viewer_sessions').select('revoked_at').where('id','=',sessionId).executeTakeFirst())?.revoked_at).not.toBeNull();
 expect((await db.executor.selectFrom('public_site_invitation_deliveries').select('state').where('id','=',deliveryId).executeTakeFirst())?.state).toBe('cancelled');
 expect(store.abortOwnerMultipartUploads).toHaveBeenCalledOnce();
});
it('configured deletion revokes site immediately and durably erases dedicated assets and routing', async () => {
    const owner = { ownerId: 'user_sites_delete_wiring', machineId: 'test-machine', appSlug: 'event' };
    const service = createSitesService({ db, env, emailCapability: async () => true,
      storage: { async putObject(key, body) { objects.set(key, body as Uint8Array); return {}; }, async getObject() { return { body: null }; } } });
    const site = await service.deploy(owner, { title: 'Event', slug: 'erase-event', accessMode: 'private_email',
      config: {}, files: [{ path: 'index.html', contentType: 'text/html', body: Buffer.from('Event').toString('base64') }] });
    await insertUserMachine(db, { machineId: 'foreign-machine', clerkUserId: 'user_foreign',
      handle: 'foreign-owner', status: 'running', provisionedAt: new Date().toISOString() });
    const foreignSiteId = randomUUID();
    await db.executor.insertInto('public_sites').values({ id: foreignSiteId, owner_id: 'user_foreign',
      machine_id: 'foreign-machine', app_slug: 'foreign', title: 'Foreign', description: '', slug: null,
      revision: 1, status: 'published', access_mode: 'private_email', active_version: null,
      created_at: new Date().toISOString() }).execute();
    async function seedRelated(siteId: string, ownerId: string) {
      const invitationId = randomUUID(), grantId = randomUUID(), sessionId = randomUUID(),
        deliveryId = randomUUID(), auditId = randomUUID(), now = new Date();
      await db.transaction(async trx => {
        await trx.executor.insertInto('public_site_email_invitations').values({ id: invitationId, site_id: siteId,
          normalized_email: `${siteId}@example.com`, display_email: `${siteId}@example.com`, generation: '1',
          state: 'accepted', delivery_state: 'sent', invited_by_clerk_user_id: ownerId,
          accepted_clerk_user_id: `user_guest_${siteId}`, created_at: now, issued_at: now,
          expires_at: new Date(now.getTime() + 86400_000), accepted_at: now, revoked_at: null,
          state_reason: null, updated_at: now, revision: '0' }).execute();
        await trx.executor.insertInto('public_site_viewer_grants').values({ id: grantId, site_id: siteId,
          invitation_id: invitationId, invitation_generation: '1', clerk_user_id: `user_guest_${siteId}`,
          granted_at: now, revoked_at: null, revocation_reason: null }).execute();
        await trx.executor.insertInto('public_site_viewer_sessions').values({ id: sessionId, site_id: siteId,
          grant_id: grantId, secret_hash: 'a'.repeat(64), clerk_session_key: 'b'.repeat(64),
          created_at: now, expires_at: new Date(now.getTime() + 86400_000), last_seen_at: null,
          revoked_at: null }).execute();
        await trx.executor.insertInto('public_site_invitation_deliveries').values({ id: deliveryId,
          invitation_id: invitationId, invitation_generation: '1', idempotency_key: randomUUID(),
          state: 'sent', attempts: 1, available_at: now, lease_token: null, lease_until: null,
          provider_message_id: null, failure_code: null, sent_at: now, created_at: now, updated_at: now }).execute();
        await trx.executor.insertInto('public_site_access_audit_events').values({ id: auditId, site_id: siteId,
          invitation_id: invitationId, event_type: 'invitation_accepted', actor_kind: 'viewer',
          actor_reference: `user_guest_${siteId}`, details: { generation: 1 }, occurred_at: now }).execute();
      });
      return { siteId, invitationId, grantId };
    }
    async function relatedCounts(ref: { siteId: string; invitationId: string; grantId: string }) {
      return {
        invitations: (await db.executor.selectFrom('public_site_email_invitations').select('id').where('site_id', '=', ref.siteId).execute()).length,
        grants: (await db.executor.selectFrom('public_site_viewer_grants').select('id').where('site_id', '=', ref.siteId).execute()).length,
        sessions: (await db.executor.selectFrom('public_site_viewer_sessions').select('id').where('grant_id', '=', ref.grantId).execute()).length,
        deliveries: (await db.executor.selectFrom('public_site_invitation_deliveries').select('id').where('invitation_id', '=', ref.invitationId).execute()).length,
        audit: (await db.executor.selectFrom('public_site_access_audit_events').select('id').where('site_id', '=', ref.siteId).execute()).length,
      };
    }
    const erased = await seedRelated(site.id, owner.ownerId);
    const retained = await seedRelated(foreignSiteId, 'user_foreign');
    expect(await relatedCounts(erased)).toEqual({ invitations: 1, grants: 1, sessions: 1, deliveries: 1, audit: 1 });
    expect(await relatedCounts(retained)).toEqual({ invitations: 1, grants: 1, sessions: 1, deliveries: 1, audit: 1 });
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
        expect(await relatedCounts(erased)).toEqual({ invitations: 0, grants: 0, sessions: 0, deliveries: 0, audit: 0 });
        expect(await relatedCounts(retained)).toEqual({ invitations: 1, grants: 1, sessions: 1, deliveries: 1, audit: 1 });
        expect(await db.executor.selectFrom('public_sites').select('id').where('id','=',foreignSiteId).execute()).toHaveLength(1);
    }
    finally {
        runtime?.stop();
        await runtime?.drain();
        runtime?.close();
    }
    expect(sitesStore.destroy).toHaveBeenCalledOnce();
    expect(syncStore.destroy).toHaveBeenCalledOnce();
});
it('rolls back recipient erasure and viewer identity when final account cleanup is blocked', async () => {
    const recipient='user_recipient_rollback', owner='user_foreign_site_owner';
    const siteId=randomUUID(), invitationId=randomUUID(), grantId=randomUUID(), now=new Date();
    await insertUserMachine(db,{machineId:'recipient-blocked-machine',clerkUserId:recipient,
        handle:'recipient-rollback',status:'running',provisionedAt:now.toISOString()});
    await insertUserMachine(db,{machineId:'foreign-site-machine',clerkUserId:owner,handle:'foreign-site',status:'running',provisionedAt:now.toISOString()});
    await db.executor.insertInto('public_sites').values({id:siteId,owner_id:owner,machine_id:'foreign-site-machine',
        app_slug:'foreign-app',title:'Foreign app',description:'',slug:null,revision:1,status:'published',
        access_mode:'private_email',active_version:null,created_at:now.toISOString()}).execute();
    await db.executor.insertInto('public_site_email_invitations').values({id:invitationId,site_id:siteId,
        normalized_email:'recipient@example.com',display_email:'recipient@example.com',generation:'1',
        state:'accepted',delivery_state:'sent',invited_by_clerk_user_id:owner,accepted_clerk_user_id:recipient,
        created_at:now,issued_at:now,expires_at:new Date(now.getTime()+86400_000),accepted_at:now,
        revoked_at:null,state_reason:null,updated_at:now,revision:'1'}).execute();
    await db.executor.insertInto('public_site_viewer_grants').values({id:grantId,site_id:siteId,
        invitation_id:invitationId,invitation_generation:'1',clerk_user_id:recipient,granted_at:now,
        revoked_at:null,revocation_reason:null}).execute();
    const recipientKey=siteRecipientKey(recipient,env.ACCOUNT_DELETION_SECRET);
    await db.executor.insertInto('public_site_recipient_lifecycle').values({recipient_key:recipientKey,state:'active',
        last_event_id:'initial_active',last_event_at:new Date(now.getTime()-1000),updated_at:now}).execute();
    await expect(eraseOwnerPlatformData(db,recipient,undefined,env.ACCOUNT_DELETION_SECRET))
        .rejects.toThrow('runtime_cleanup_pending');
    expect((await db.executor.selectFrom('public_site_recipient_lifecycle').select('state')
        .where('recipient_key','=',recipientKey).executeTakeFirst())?.state).toBe('active');
    expect((await db.executor.selectFrom('public_site_viewer_grants').select(['clerk_user_id','revoked_at'])
        .where('id','=',grantId).executeTakeFirst())).toMatchObject({clerk_user_id:recipient,revoked_at:null});
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
