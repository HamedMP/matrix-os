import {createHash,randomUUID} from "node:crypto";
import {Kysely,sql} from "kysely";
import {KyselyPGlite} from "kysely-pglite";
import {describe,expect,it,vi} from "vitest";
import {bootstrapOrganizationDriveDatabase,type OrganizationDriveDatabase} from "../../packages/gateway/src/organization-drive/database.js";
import {OrganizationDriveService} from "../../packages/gateway/src/organization-drive/service.js";
const scopeId="00000000-0000-4000-8000-000000000001";
const identity={organizationId:"org_example",scopeId,authorityRuntimeId:"vps:owner",authorityGeneration:1};
async function fixture(){
 const instance=await KyselyPGlite.create();const statements:string[]=[];const db=new Kysely<OrganizationDriveDatabase>({dialect:instance.dialect,log:event=>{if(event.level==="query"){if(statements.length===200)statements.shift();statements.push(event.query.sql);}}});
 await bootstrapOrganizationDriveDatabase(db);
 await sql`CREATE TABLE collaboration_scopes (id UUID PRIMARY KEY,resource_id TEXT NOT NULL,revision BIGINT NOT NULL,deleted_at TIMESTAMPTZ)`.execute(db);
 await sql`CREATE TABLE collaboration_events (scope_id UUID NOT NULL,scope_seq BIGINT NOT NULL,event_id UUID NOT NULL,resource_kind TEXT NOT NULL,resource_id TEXT NOT NULL,revision BIGINT NOT NULL,authority_generation BIGINT NOT NULL,event_type TEXT NOT NULL,payload JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL,PRIMARY KEY(scope_id,scope_seq))`.execute(db);
 await sql`INSERT INTO collaboration_scopes VALUES (${scopeId},'folder-drive',1,NULL)`.execute(db);
 const objects=new Map<string,Uint8Array>();let staged=new Uint8Array();let wrongLength=false;const cancel=vi.fn();
 const getObject=vi.fn(async(key:string)=>{const bytes=objects.get(key)??staged;return {body:new ReadableStream<Uint8Array>({start(c){c.enqueue(bytes);if(!wrongLength)c.close();},cancel}),contentLength:wrongLength?bytes.length+1:bytes.length};});
 const service=new OrganizationDriveService({db,ownerId:"user_owner",runtimeSlot:"primary",r2:{getObject,getPresignedPutUrl:async()=>"https://storage.example/put",getPresignedGetUrl:async()=>"https://storage.example/get",putObject:async(key,bytes)=>{if(!objects.has(key)&&objects.size>=16)objects.delete(objects.keys().next().value!);objects.set(key,new Uint8Array(bytes));},deleteObject:async key=>{objects.delete(key);}}});
 await service.enable({...identity,runtimeId:"vps:owner",generation:1,quotaBytes:10_000_000});
 async function upload(path:string,text:string,baseVersion=0){staged=new TextEncoder().encode(text);const reserved=await service.reserve({...identity,actorId:"user_owner",request:{path,size:staged.length,sha256:createHash("sha256").update(staged).digest("hex"),requestId:randomUUID(),baseVersion}});return service.commit({...identity,actorId:"user_owner",uploadId:reserved.uploadId});}
 return {db,service,objects,getObject,cancel,upload,statements,wrongLength(){wrongLength=true;},close:async()=>{objects.clear();await db.destroy();}};
}
describe("organization drive context authority persistence",()=>{
 it("reads current or pinned immutable versions without storage keys",async()=>{
  const f=await fixture();try{const one=await f.upload("reports/plan.md","version one");await f.upload(one.path,"version two",1);
   const current=await f.service.readContext({...identity,fileId:one.id,revalidate:async()=>undefined});
   const pinned=await f.service.readContext({...identity,fileId:one.id,version:1,revalidate:async()=>undefined});
   expect(current).toMatchObject({status:"text",file:{version:2},text:"version two",readOnly:true});expect(pinned).toMatchObject({file:{version:1},text:"version one"});
   expect(JSON.stringify(current)).not.toMatch(/object_key|getUrl|storage\.example/);
  }finally{await f.close();}
 });
 it("searches literal scoped paths with case-insensitive terms and a bounded cursor",async()=>{
  const f=await fixture();try{await f.upload("reports/a_plan.md","a");await f.upload("reports/aXplan.md","b");await f.upload("reports-old/a_plan.md","c");
   expect((await f.service.list({...identity,prefix:"reports",query:"A_PLAN"})).files.map(x=>x.path)).toEqual(["reports/a_plan.md"]);
   expect(f.statements).toContain("SET LOCAL statement_timeout = '5s'");
   const first=await f.service.list({...identity,prefix:"reports",limit:1});expect(first.nextCursor).toBe("reports/aXplan.md");
   expect((await f.service.list({...identity,prefix:"reports",limit:1,after:first.nextCursor})).files.map(x=>x.path)).toEqual(["reports/a_plan.md"]);
  }finally{await f.close();}
 });
 it("does not expose other organization or tombstoned files",async()=>{
  const f=await fixture();try{const one=await f.upload("private.md","data");f.getObject.mockClear();
   await expect(f.service.readContext({...identity,organizationId:"org_other",fileId:one.id,revalidate:async()=>undefined})).rejects.toMatchObject({code:"not_found"});
   await f.db.updateTable("organization_drive_files").set({deleted_at:new Date().toISOString()}).where("id","=",one.id).execute();
   await expect(f.service.readContext({...identity,fileId:one.id,revalidate:async()=>undefined})).rejects.toMatchObject({code:"not_found"});expect(f.getObject).not.toHaveBeenCalled();
  }finally{await f.close();}
 });
 it("checks membership again after verification before returning bytes",async()=>{
  const f=await fixture();try{const one=await f.upload("plan.md","data");f.getObject.mockClear();
   await expect(f.service.readContext({...identity,fileId:one.id,revalidate:async()=>{throw new Error("revoked");}})).rejects.toThrow("revoked");expect(f.getObject).toHaveBeenCalledOnce();
  }finally{await f.close();}
 });
 it("does not return a file deleted while authorization is revalidated",async()=>{
  const f=await fixture();try{const one=await f.upload("plan.md","data");
   await expect(f.service.readContext({...identity,fileId:one.id,revalidate:async()=>{await f.db.updateTable("organization_drive_files").set({deleted_at:new Date().toISOString()}).where("id","=",one.id).execute();}})).rejects.toMatchObject({code:"not_found"});
  }finally{await f.close();}
 });
 it("rejects corrupted stored bytes and cancels mismatched length streams",async()=>{
  const f=await fixture();try{const one=await f.upload("plan.md","data");const key=[...f.objects.keys()][0]!;f.objects.set(key,new TextEncoder().encode("evil"));
   await expect(f.service.readContext({...identity,fileId:one.id,revalidate:async()=>undefined})).rejects.toMatchObject({code:"checksum"});
   f.wrongLength();f.cancel.mockClear();await expect(f.service.readContext({...identity,fileId:one.id,revalidate:async()=>undefined})).rejects.toMatchObject({code:"checksum"});expect(f.cancel).toHaveBeenCalledOnce();
  }finally{await f.close();}
 });
 it("marks binaries unsupported and skips downloads for oversized files",async()=>{
  const f=await fixture();try{const one=await f.upload("binary.bin","a\0b");expect(await f.service.readContext({...identity,fileId:one.id,revalidate:async()=>undefined})).toMatchObject({status:"unsupported",readOnly:true});
   await f.db.updateTable("organization_drive_versions").set({size_bytes:5_000_000}).where("file_id","=",one.id).execute();f.getObject.mockClear();
   expect(await f.service.readContext({...identity,fileId:one.id,revalidate:async()=>undefined})).toMatchObject({status:"unsupported"});expect(f.getObject).not.toHaveBeenCalled();
  }finally{await f.close();}
 });
});
