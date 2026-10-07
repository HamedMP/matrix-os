import { createHmac } from 'node:crypto';
import { sql } from 'kysely';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestPlatformDb } from './platform-db-test-helper.js';
import { stubOrchestrator } from './proxy-routing-test-utils.js';
import { createConfiguredAccountDeletionRuntime } from '../../packages/platform/src/account-deletion/wiring.js';
import { createApp } from '../../packages/platform/src/main.js';
import { createPlatformDb as createGatewayDb } from '../../packages/gateway/src/platform-db.js';
import { CustomMcpBroker } from '../../packages/gateway/src/integrations/custom-mcp/broker.js';
import { CustomMcpOAuthManager } from '../../packages/gateway/src/integrations/custom-mcp/oauth.js';
import { encryptCustomMcpCredential } from '../../packages/gateway/src/integrations/custom-mcp/crypto.js';

const store=vi.hoisted(()=>({listObjects:vi.fn(async()=>({keys:[],nextCursor:null})),deleteObject:vi.fn(),abortOwnerMultipartUploads:vi.fn(),destroy:vi.fn(),getPresignedGetUrl:vi.fn()}));
vi.mock('../../packages/platform/src/account-deletion/storage.js',async importOriginal=>({...await importOriginal<object>(),createAccountDeletionObjectStore:()=>store}));
afterEach(()=>vi.restoreAllMocks());
describe('production deletion composition',()=>{
 it('revokes owner Custom MCP grants before erasure and retries with their credentials retained',async()=>{
   const {db,instance}=await createTestPlatformDb();
   const gatewayDb=createGatewayDb({dialect:instance.dialect});
   await gatewayDb.migrate();
   const env={ACCOUNT_DELETION_ENABLED:'true',ACCOUNT_DELETION_SECRET:'s'.repeat(32),CLERK_SECRET_KEY:'test',R2_ACCESS_KEY_ID:'test',R2_SECRET_ACCESS_KEY:'test'};
   const ownerUuid='11111111-1111-4111-8111-111111111111';
   const foreignUuid='22222222-2222-4222-8222-222222222222';
   await sql`INSERT INTO users (id,clerk_id,handle,display_name,email,container_id)
     VALUES (${ownerUuid},'user_mcp','mcpowner','Owner','owner@example.test','owner'),
            (${foreignUuid},'user_foreign','other','Other','other@example.test','other')`.execute(db.executor);
   const encryptionKey=Buffer.alloc(32);
   const ownerServerId='33333333-3333-4333-8333-333333333333';
   const foreignServerId='44444444-4444-4444-8444-444444444444';
   const credential={oauth:{refreshToken:'owner_grant',clientId:'fixture_client',revocationEndpoint:'https://oauth.example.test/revoke'}};
   const encrypted=encryptCustomMcpCredential(credential,encryptionKey,{userId:ownerUuid,serverId:ownerServerId});
   await gatewayDb.createCustomMcpServer({id:ownerServerId,userId:ownerUuid,name:'Owner OAuth',url:'https://mcp.example.test/mcp',
     authMode:'oauth',encryptedCredentials:encrypted,pendingExpiresAt:new Date(Date.now()+60_000)});
   await gatewayDb.createCustomMcpServer({id:foreignServerId,userId:foreignUuid,name:'Other connection',url:'https://mcp.example.test/mcp',
     authMode:'none',pendingExpiresAt:new Date(Date.now()+60_000)});
   vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
     if(String(url).includes('organization_memberships'))return Response.json({data:[],total_count:0});
     if(String(url).includes('/users/'))return init?.method==='DELETE'?Response.json({deleted:true}):Response.json({external_accounts:[]});
     throw Error('unexpected outbound request');
   });
   const revokeRequest=vi.fn(async()=>({status:200,body:undefined}));
   revokeRequest.mockRejectedValueOnce(Error('remote unavailable'));
   const oauth=new CustomMcpOAuthManager({db:gatewayDb,encryptionKey,redirectUri:'https://app.example.test/callback',request:revokeRequest});
   const projectionRemove=vi.fn(async()=>{throw Error('runtime destroyed');});
   const broker=new CustomMcpBroker({db:gatewayDb,encryptionKey,projection:{upsert:vi.fn(),remove:projectionRemove},
     revokeOAuth:credential=>oauth.revoke(credential)});
   const remove=vi.fn((userId:string,serverId:string)=>broker.removeForAccountDeletion(userId,serverId));
   const runtime=await createConfiguredAccountDeletionRuntime({db,env,backgroundWorkersEnabled:false,customMcp:{remove}});
   try{
     await runtime!.service.schedule('user_mcp');
     await sql`UPDATE account_deletion_jobs SET due_at='2020-01-01',next_attempt_at='2020-01-01'`.execute(db.executor);
     await runtime!.service.reconcile();
     expect((await runtime!.service.get('user_mcp'))?.status).not.toBe('completed');
     expect((await sql`SELECT encrypted_credentials FROM custom_mcp_servers WHERE id=${ownerServerId}`.execute(db.executor)).rows)
       .toEqual([{encrypted_credentials:encrypted}]);
     await sql`UPDATE account_deletion_jobs SET next_attempt_at='2020-01-01'`.execute(db.executor);
     await runtime!.service.reconcile();
     expect(await runtime!.service.get('user_mcp')).toMatchObject({status:'completed'});
     expect(remove).toHaveBeenCalledTimes(2);
     expect(remove).toHaveBeenLastCalledWith(ownerUuid,ownerServerId);
     expect(revokeRequest).toHaveBeenLastCalledWith({method:'POST',url:'https://oauth.example.test/revoke',
       headers:{'content-type':'application/x-www-form-urlencoded'},body:'token=owner_grant&client_id=fixture_client'});
     expect(projectionRemove).not.toHaveBeenCalled();
     expect((await sql`SELECT id FROM custom_mcp_servers`.execute(db.executor)).rows).toEqual([{id:foreignServerId}]);
   // Both repositories borrow the same test PGlite instance; its owner closes it once.
   }finally{runtime?.stop();await runtime?.drain();runtime?.close();await db.destroy();}
 });
 it('reaches durable cleanup through real app auth and signed webhook without requiring a VPS or payment',async()=>{
   const {db}=await createTestPlatformDb();
   const key=Buffer.from('s'.repeat(32));
   const env={ACCOUNT_DELETION_ENABLED:'true',ACCOUNT_DELETION_SECRET:'s'.repeat(32),CLERK_SECRET_KEY:'test',R2_ACCESS_KEY_ID:'test',R2_SECRET_ACCESS_KEY:'test',CLERK_USER_WEBHOOK_SIGNING_SECRET:'whsec_'+key.toString('base64')};
   vi.spyOn(globalThis,'fetch').mockImplementation(async(url,init)=>{
     if(String(url).includes('organization_memberships'))return Response.json({data:[],total_count:0});
     if(String(url).includes('/users/'))return init?.method==='DELETE'?Response.json({deleted:true}):Response.json({external_accounts:[]});
     throw Error('unexpected outbound request');
   });
   const runtime=await createConfiguredAccountDeletionRuntime({db,env,backgroundWorkersEnabled:false});
   try{
     const app=createApp({db,env,orchestrator:stubOrchestrator(),accountDeletion:runtime,clerkAuth:{verify:async(token:string)=>({authenticated:token==='valid',userId:'user_wiring'}),extractToken:()=>null} as never});
     const scheduled=await app.request('/api/account/delete',{method:'POST',headers:{authorization:'Bearer valid','content-type':'application/json'},body:JSON.stringify({confirm:true})});
     expect(scheduled.status).toBe(202);
     expect(await scheduled.json()).toMatchObject({status:'scheduled',billingStopped:true});
     expect(await db.executor.selectFrom('account_deletion_jobs').selectAll().execute()).toHaveLength(1);
     const body=JSON.stringify({type:'user.deleted',data:{id:'user_wiring',deleted:true}});
     const time=String(Math.floor(Date.now()/1000));
     const signature=createHmac('sha256',key).update('evt_wiring.'+time+'.'+body).digest('base64');
     expect((await app.request('/webhooks/clerk/users',{method:'POST',headers:{'svix-id':'evt_wiring','svix-timestamp':time,'svix-signature':'v1,'+signature},body})).status).toBe(200);
     await runtime!.service.reconcile();
     expect(await runtime!.service.get('user_wiring')).toMatchObject({status:'completed'});
     const job=await db.executor.selectFrom('account_deletion_jobs').selectAll().executeTakeFirstOrThrow();
     expect(job.encrypted_context).toBeNull();
     expect(store.listObjects).toHaveBeenCalledWith('matrixos-sync/user_wiring/');
     expect((await app.request('/api/account/delete/export/platform',{headers:{authorization:'Bearer valid'}})).status).toBe(409);
   }finally{runtime?.stop();await runtime?.drain();runtime?.close();await db.destroy();}
 });
});
