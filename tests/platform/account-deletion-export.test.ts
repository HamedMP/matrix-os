import { describe, expect, it, vi } from 'vitest';
import { exportOwnerPlatformData, listAccountExportFiles } from '../../packages/platform/src/account-deletion/export.js';
describe('account export downloads', () => {
  it('returns authenticated, short-lived downloads for owner files and database snapshots', async () => {
    const sign = vi.fn(async (key:string) => `https://storage.example.test/${key}?signed=yes`);
    const store = { listObjects: async () => ({ keys: ['matrixos-sync/user_a/system/db/snapshots/2026-10-01T1200Z.dump',
      'matrixos-sync/user_a/files/projects/notes.txt'], nextCursor:null }), getPresignedGetUrl:sign,
      deleteObject:vi.fn(),abortOwnerMultipartUploads:vi.fn() };
    const result = await listAccountExportFiles(store,'user_a','matrixos-sync');
    expect(result.files.map((file)=>file.kind)).toEqual(['database','file']);
    expect(sign.mock.calls.every((call)=>call[1]===900)).toBe(true);
    expect(result.migrationInstructions).toContain('pg_restore');
  });
  it('does not sign cross-owner object inventory or sensitive internal metadata', async () => {
    const sign = vi.fn();
    const store = { listObjects: async () => ({keys:['matrixos-sync/user_ab/files/stolen'],nextCursor:null}),
      getPresignedGetUrl:sign,deleteObject:vi.fn(),abortOwnerMultipartUploads:vi.fn() };
    await expect(listAccountExportFiles(store,'user_a','matrixos-sync')).rejects.toThrow('Storage ownership mismatch');
    expect(sign).not.toHaveBeenCalled();
  });
  it('continues into the dedicated sites store and namespaces published assets',async()=>{
    const primarySign=vi.fn(async(key:string)=>'https://primary.example.test/'+key);
    const sitesSign=vi.fn(async(key:string)=>'https://sites.example.test/'+key);
    const primary={listObjects:vi.fn(async()=>({keys:[],nextCursor:null})),getPresignedGetUrl:primarySign,
      deleteObject:vi.fn(),abortOwnerMultipartUploads:vi.fn()};
    const sites={listObjects:vi.fn(async()=>({keys:['sites/owners/user_a/site/version/index.html'],nextCursor:null})),
      getPresignedGetUrl:sitesSign,deleteObject:vi.fn(),abortOwnerMultipartUploads:vi.fn()};
    const files=[];let cursor:string|undefined;let page;
    do{page=await listAccountExportFiles(primary,'user_a','matrixos-sync',cursor,sites);files.push(...page.files);cursor=page.nextCursor??undefined;}while(cursor);
    expect(files).toEqual([{path:'sites/site/version/index.html',kind:'file',
      downloadUrl:'https://sites.example.test/sites/owners/user_a/site/version/index.html',expiresIn:900}]);
    expect(page.nextCursor).toBeNull();expect(primarySign).not.toHaveBeenCalled();
    expect(sitesSign).toHaveBeenCalledWith('sites/owners/user_a/site/version/index.html',900);
  });
});

import { sql } from 'kysely';
import { createTestPlatformDb } from './native-platform-db-test-helper.js';
describe('portable account exports',()=>{
 it('traverses all pages of every owner storage prefix and excludes reachability secrets',async()=>{
   const list=vi.fn(async(prefix:string,cursor?:string)=>{
     if(prefix==='matrixos-sync/user_a/'&&!cursor)return {keys:[prefix+'one'],nextCursor:'page2'};
     if(prefix==='matrixos-sync/user_a/'&&cursor==='page2')return {keys:[prefix+'two',prefix+'system/vps-meta.json'],nextCursor:null};
     if(prefix==='custom/user_a/'&&!cursor)return {keys:[prefix+'three'],nextCursor:null};
     if(prefix==='matrixos-sync/v2/owners/user_a/runtimes/'&&!cursor)return {keys:[prefix+'studio/files/four'],nextCursor:null};
     throw Error('wrong page');
   });
   const sign=vi.fn(async(key:string)=>'https://storage.example.test/'+key);
   const store={listObjects:list,getPresignedGetUrl:sign,deleteObject:vi.fn(),abortOwnerMultipartUploads:vi.fn()};
   const a=await listAccountExportFiles(store,'user_a','custom');
   const b=await listAccountExportFiles(store,'user_a','custom',a.nextCursor!);
   const c=await listAccountExportFiles(store,'user_a','custom',b.nextCursor!);
   const d=await listAccountExportFiles(store,'user_a','custom',c.nextCursor!);
   expect([a,b,c,d].flatMap(page=>page.files.map(file=>file.path))).toEqual(['one','two','three','studio/files/four']);
   expect(d.nextCursor).toBeNull();expect(list.mock.calls).toEqual([['matrixos-sync/user_a/',undefined],['matrixos-sync/user_a/','page2'],['custom/user_a/',undefined],['matrixos-sync/v2/owners/user_a/runtimes/',undefined]]);
   expect(sign).not.toHaveBeenCalledWith(expect.stringContaining('vps-meta'),expect.anything());
 });
 it('exports only the authenticated owner records without credentials or delivery payloads',async()=>{
   const {db}=await createTestPlatformDb();
   try{
     await sql`INSERT INTO users (id,clerk_id,handle,display_name,email,container_id,pipedream_external_id)
       VALUES ('11111111-1111-4111-8111-111111111111','user_a','mine','Owner','owner@example.test','private-runtime-token','secret-integration-id'),
              ('22222222-2222-4222-8222-222222222222','user_b','other','Other','other@example.test','other-secret',null)`.execute(db.executor);
     await sql`INSERT INTO social_posts (id,author_id,content,type,created_at) VALUES
       ('mine-post','11111111-1111-4111-8111-111111111111','portable','text','2026-10-01'),('foreign','22222222-2222-4222-8222-222222222222','private other data','text','2026-10-01')`.execute(db.executor);
     await sql`INSERT INTO public_sites (id,owner_id,machine_id,app_slug,title,description,slug,revision,status,active_version,created_at) VALUES
       ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','user_a','machine-a','launch','Launch','Portable site','launch',1,'published','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','2026-10-01'),
       ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','user_b','machine-b','private','Private','Other owner','private',1,'published','dddddddd-dddd-4ddd-8ddd-dddddddddddd','2026-10-01')`.execute(db.executor);
     await sql`INSERT INTO public_site_versions (id,site_id,created_at,config,files) VALUES
       ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2026-10-01',${JSON.stringify({data:{message:'portable site data'},forms:[]})}::jsonb,${JSON.stringify([{path:'index.html',contentType:'text/html',bytes:12}])}::jsonb),
       ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','cccccccc-cccc-4ccc-8ccc-cccccccccccc','2026-10-01',${JSON.stringify({data:{message:'private other site'},forms:[]})}::jsonb,${JSON.stringify([])}::jsonb)`.execute(db.executor);
     await sql`INSERT INTO public_site_aliases (slug,site_id) VALUES
       ('launch','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),('private','cccccccc-cccc-4ccc-8ccc-cccccccccccc')`.execute(db.executor);
     await sql`INSERT INTO public_site_access_links (id,site_id,claim_token_hash,session_token_hash,created_at,claim_expires_at,claimed_at,session_expires_at) VALUES
       ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',${'a'.repeat(64)},${'b'.repeat(64)},'2026-10-02','2026-10-09','2026-10-03','2026-11-02'),
       ('ffffffff-ffff-4fff-8fff-ffffffffffff','cccccccc-cccc-4ccc-8ccc-cccccccccccc',${'c'.repeat(64)},null,'2026-10-02','2026-10-09',null,null)`.execute(db.executor);
     await sql`INSERT INTO public_site_email_invitations
       (id,site_id,normalized_email,display_email,state,delivery_state,invited_by_clerk_user_id,created_at,issued_at,expires_at,updated_at)
       VALUES ('01010101-0101-4101-8101-010101010101','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','guest@example.test','guest@example.test','pending','queued','user_a',now(),now(),now()+interval '7 days',now()),
       ('02020202-0202-4202-8202-020202020202','cccccccc-cccc-4ccc-8ccc-cccccccccccc','foreign@example.test','foreign@example.test','pending','queued','user_b',now(),now(),now()+interval '7 days',now())`.execute(db.executor);
     await sql`INSERT INTO public_site_viewer_grants
       (id,site_id,invitation_id,invitation_generation,clerk_user_id,granted_at,revoked_at,revocation_reason)
       VALUES ('03030303-0303-4303-8303-030303030303','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','01010101-0101-4101-8101-010101010101',1,'user_guest',now(),now(),'owner')`.execute(db.executor);
     await sql`INSERT INTO public_site_viewer_sessions
       (id,site_id,grant_id,secret_hash,clerk_session_key,created_at,expires_at,revoked_at)
       VALUES ('04040404-0404-4404-8404-040404040404','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','03030303-0303-4303-8303-030303030303',${'d'.repeat(64)},${'e'.repeat(64)},now(),now()+interval '7 days',now())`.execute(db.executor);
     await sql`INSERT INTO public_site_invitation_deliveries
       (id,invitation_id,invitation_generation,idempotency_key,state,available_at,provider_message_id,created_at,updated_at)
       VALUES ('05050505-0505-4505-8505-050505050505','01010101-0101-4101-8101-010101010101',1,'06060606-0606-4606-8606-060606060606','sent',now(),'secret-provider-id',now(),now())`.execute(db.executor);
     await sql`INSERT INTO public_site_access_audit_events
       (id,site_id,invitation_id,event_type,actor_kind,actor_reference,details,occurred_at)
       VALUES ('07070707-0707-4707-8707-070707070707','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','01010101-0101-4101-8101-010101010101','invitation_created','owner','user_a','{}'::jsonb,now())`.execute(db.executor);
     const result=await exportOwnerPlatformData(db,'user_a');
     expect(result.profile).toHaveLength(1);expect(result.posts.map(post=>post.content)).toEqual(['portable']);
     expect(result.publicSites.sites.map(site=>site.id)).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
     expect(result.publicSites.versions.map(version=>version.config)).toEqual([{data:{message:'portable site data'},forms:[]}]);
     expect(result.publicSites.aliases).toEqual([{slug:'launch',site_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}]);
     expect(result.publicSites.accessLinks).toEqual([{id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',site_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',created_at:'2026-10-02',claim_expires_at:'2026-10-09',claimed_at:'2026-10-03',session_expires_at:'2026-11-02'}]);
     expect(result.publicSites.emailInvitations).toMatchObject([{id:'01010101-0101-4101-8101-010101010101',normalized_email:'guest@example.test'}]);
     expect(result.publicSites.viewerGrants).toMatchObject([{id:'03030303-0303-4303-8303-030303030303',clerk_user_id:'user_guest'}]);
     expect(result.publicSites.viewerSessions).toMatchObject([{id:'04040404-0404-4404-8404-040404040404'}]);
     expect(result.publicSites.deliveryOutbox).toMatchObject([{id:'05050505-0505-4505-8505-050505050505',state:'sent'}]);
     expect(result.publicSites.auditEvents).toMatchObject([{id:'07070707-0707-4707-8707-070707070707',event_type:'invitation_created'}]);
     expect(JSON.stringify(result)).not.toMatch(/private-runtime-token|secret-integration-id|other-secret|private other data|private other site|foreign@example|secret-provider-id|a{64}|b{64}|c{64}|d{64}|e{64}/);
     await expect(exportOwnerPlatformData(db,'user_b/../user_a')).rejects.toThrow();
   }finally{await db.destroy();}
 });
});
