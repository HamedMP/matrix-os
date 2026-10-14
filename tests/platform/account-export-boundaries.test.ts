import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { decodeExportCursor, encodeExportCursor } from '../../packages/platform/src/account-deletion/export-cursor.js';
import { listAccountExportFiles } from '../../packages/platform/src/account-deletion/export.js';

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
});

import { sql } from 'kysely';
import { createTestPlatformDb } from './native-platform-db-test-helper.js';
import { exportOwnerPlatformData } from '../../packages/platform/src/account-deletion/export.js';
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
