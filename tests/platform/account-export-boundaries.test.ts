import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { decodeExportCursor, encodeExportCursor } from '../../packages/platform/src/account-deletion/export-cursor.js';
import { exportOwnerPlatformData, listAccountExportFiles } from '../../packages/platform/src/account-deletion/export.js';
import { createTestPlatformDb } from './native-platform-db-test-helper.js';

const secret='fixture-export-secret-that-is-stable';
const schema=z.object({ after:z.string() }).strict();
describe('account export continuation boundaries',()=>{
  it('binds encrypted continuations to the exact owner, export purpose and secret',()=>{
    const token=encodeExportCursor({after:'PRIVATE_BILLING_KEY'},'user_a','records',secret);
    expect(Buffer.from(token,'base64url').toString()).not.toContain('PRIVATE_BILLING_KEY');
    expect(decodeExportCursor(token,'user_a','records',schema,secret)).toEqual({after:'PRIVATE_BILLING_KEY'});
    expect(()=>decodeExportCursor(token,'user_b','records',schema,secret)).toThrow();
    expect(()=>decodeExportCursor(token,'user_a','files:matrixos-sync',schema,secret)).toThrow();
    expect(()=>decodeExportCursor(token,'user_a','records',schema,'different-secret')).toThrow();
    const modified=Buffer.from(token,'base64url');modified[modified.length-1]^=1;
    expect(()=>decodeExportCursor(modified.toString('base64url'),'user_a','records',schema,secret)).toThrow();
  });
  it('uses null when source metadata is absent, never fabricates a timestamp',async()=>{
    const result=await listAccountExportFiles({listObjects:async(prefix)=>({keys:[prefix+'notes.txt'],nextCursor:null}),
      getPresignedGetUrl:async()=> 'https://storage.example.test/notes',deleteObject:async()=>{},abortOwnerMultipartUploads:async()=>{}},'user_a','matrixos-sync');
    expect(result.files[0]).toMatchObject({lastModified:null,sizeBytes:null,expiresIn:900});
  });
  it('reauthorizes a relisted object instead of persisting its bearer URL',async()=>{
    let issuance=0;
    const store={listObjects:async(prefix:string)=>({keys:[prefix+'notes.txt'],nextCursor:null}),
      getPresignedGetUrl:async()=>`https://storage.example.test/notes?issuance=${++issuance}`,
      deleteObject:async()=>{},abortOwnerMultipartUploads:async()=>{}};
    const first=await listAccountExportFiles(store,'user_a','matrixos-sync');
    const refreshed=await listAccountExportFiles(store,'user_a','matrixos-sync');
    expect(first.files[0].downloadUrl).not.toBe(refreshed.files[0].downloadUrl);
    expect(Date.parse(first.files[0].expiresAt)-Date.now()).toBeGreaterThan(899_000);
  });
  it('carries previous nonempty pages across an empty final runtime prefix',async()=>{
    const store={listObjects:async(prefix:string)=>({keys:prefix==='matrixos-sync/user_a/'?[prefix+'notes.txt']:[],nextCursor:null}),
      getPresignedGetUrl:async()=> 'https://storage.example.test/notes',deleteObject:async()=>{},abortOwnerMultipartUploads:async()=>{}};
    const first=await listAccountExportFiles(store,'user_a','matrixos-sync',undefined,{secret,hasComputer:true});
    const last=await listAccountExportFiles(store,'user_a','matrixos-sync',first.nextCursor!,{secret,hasComputer:true});
    expect(last.files).toEqual([]);expect(last.nextCursor).toBeNull();expect(last.inventoryStatus).toBe('available');
  });
  it('does not convert a storage failure into an empty successful export',async()=>{
    await expect(listAccountExportFiles({listObjects:async()=>{throw new Error('fixture unavailable');},
      getPresignedGetUrl:async()=> 'https://storage.example.test/notes',deleteObject:async()=>{},abortOwnerMultipartUploads:async()=>{}},'user_a','matrixos-sync')).rejects.toThrow('fixture unavailable');
  });

  it('fails the current page instead of issuing a continuation it cannot decode',async()=>{
    const {db}=await createTestPlatformDb();
    const owner='user_long_cursor';
    const ownerId='33333333-3333-4333-8333-333333333333';
    try{
      await sql`INSERT INTO users(id,clerk_id,handle,display_name,email,container_id)
        VALUES(${ownerId},${owner},'long-cursor','Long Cursor','cursor@example.test','long-cursor-container')`.execute(db.executor);
      await sql`INSERT INTO social_posts(id,author_id,content,type,created_at)
        SELECT repeat('x', 600) || lpad(n::text, 3, '0'), ${ownerId}, 'owner-' || n, 'text', '2026-10-01T12:00:00Z'
        FROM generate_series(1,101) n`.execute(db.executor);

      await expect(exportOwnerPlatformData(db,owner,{secret})).rejects.toThrow('Export record capacity exceeded');
    }finally{await db.destroy();}
  });
});

it('preserves exact owner credit amounts outside JavaScript safe integer precision',async()=>{
  const {db}=await createTestPlatformDb();
  try{
    await sql`INSERT INTO user_machines(machine_id,clerk_user_id,handle,provisioned_at)
      VALUES('precision-machine','user_precision','precision','2026-10-01T12:00:00Z')`.execute(db.executor);
    await sql`INSERT INTO ai_funded_credit_ledger(entry_id,owner_id,machine_id,runtime_slot,kind,amount_microusd,source_reference,created_at)
      VALUES('precision-credit','user_precision','precision-machine','primary','addon_grant',9007199254740993,'PRIVATE_SOURCE','2026-10-01T12:00:00Z')`.execute(db.executor);
    const page=await exportOwnerPlatformData(db,'user_precision');
    expect(page.creditLedger[0].amount_microusd).toBe('9007199254740993');
    expect(JSON.stringify(page)).not.toContain('PRIVATE_SOURCE');
  }finally{await db.destroy();}
});
