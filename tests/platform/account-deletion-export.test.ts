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
});

import { sql } from 'kysely';
import { createTestPlatformDb } from './platform-db-test-helper.js';
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
     await sql`INSERT INTO image_monthly_allowances VALUES ('user_a','2026-10-01',2000000,33615,0), ('user_b','2026-10-01',2000000,100000,0)`.execute(db.executor);
     await sql`INSERT INTO image_monthly_allowances VALUES ('user_a','2026-09-01',2000000,0,0)`.execute(db.executor);
     await sql`INSERT INTO user_machines (machine_id,clerk_user_id,handle,status,deleted_at,provisioned_at)
       VALUES ('export-machine','user_a','export-images','deleted','2026-10-01','2026-10-01')`.execute(db.executor);
     await sql`INSERT INTO image_generation_operations (owner_id,request_id,machine_id,runtime_slot,period_start,payload_hash,state,reserved_microusd,actual_microusd,created_at,updated_at)
       SELECT 'user_a','export_' || n::text,'export-machine','primary',CASE WHEN n <= 2500 THEN '2026-09-01' ELSE '2026-10-01' END,${'a'.repeat(64)},'succeeded',1000000,0,'2026-10-01','2026-10-01' FROM generate_series(1,5000) n`.execute(db.executor);
     const result=await exportOwnerPlatformData(db,'user_a');
     expect(result.images.operations).toHaveLength(5000);
     expect(result.images.allowances).toHaveLength(2);
     expect(Number(result.images.allowances.find(row => row.period_start === "2026-10-01")!.spent_microusd)).toBe(33615);
     expect(result.profile).toHaveLength(1);expect(result.posts.map(post=>post.content)).toEqual(['portable']);
     expect(JSON.stringify(result)).not.toMatch(/private-runtime-token|secret-integration-id|other-secret|private other data/);
     await expect(exportOwnerPlatformData(db,'user_b/../user_a')).rejects.toThrow();
   }finally{await db.destroy();}
 });
});
