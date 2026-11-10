import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SignJWT, jwtVerify } from 'jose';
import { createHash } from 'node:crypto';
import { createApp } from '../../packages/platform/src/main.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { insertContainer, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { BrowserApprovalMachineLookup } from '../../packages/platform/src/browser-approval-machine-lookup.js';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { ROUTINE_FULL_ACCESS_PROOF_HEADER, ROUTINE_FULL_ACCESS_SCOPE_HEADER, canonicalChatTurnRequestIdentity, routineFullAccessTurnRequestIdentity } from '@matrix-os/contracts';
import { issueSyncJwt } from '../../packages/platform/src/sync-jwt.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import type { Orchestrator } from '../../packages/platform/src/orchestrator.js';
const secret='synthetic-new-purpose-platform-secret',handle='owner-pc',ownerId='user_owner',machineId='machine_owner',runtimeSlot='primary';
const jwtKey=new TextEncoder().encode('synthetic-clerk-jwt-key-at-least-32-bytes');
const creationHeader='x-matrix-routine-creation-proof',originHeader='x-matrix-routine-origin-proof';
const scopeId=`rcfull_${'a'.repeat(32)}`,sourceChatId='chat_owner',interactionId='in_origin001';
const turn={clientRequestId:'req_coexistence',baseRevision:5,parts:[{type:'text' as const,text:'Persistent task'}],selection:{instanceId:'claude_code_default',model:'fixture-model'},interactionMode:'default',permissionMode:'full_access',routineCreation:'matrix' as const};
const originBody={kind:'approval' as const,baseRevision:2,decision:'approve' as const};
let db:PlatformDB,app:ReturnType<typeof createApp>,lookup:BrowserApprovalMachineLookup,received:Headers|undefined,clerkToken:string;
const lookupEnd=vi.fn(async()=>{});
beforeEach(async()=>{
 vi.stubEnv('MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED','true');
 vi.stubEnv('PLATFORM_JWT_SECRET','synthetic-sync-session-key-at-least-32-chars');vi.stubEnv('MATRIX_SUPERVISED_BROWSER_APPROVALS_ENABLED','false');vi.stubEnv('MATRIX_API_ORIGIN','https://api.matrix-os.com');
 const initialized=await createTestPlatformDb();db=initialized.db;lookupEnd.mockClear();
 lookup=new BrowserApprovalMachineLookup({databaseUrl:'postgresql://synthetic.invalid/platform',poolFactory:(()=>({connect:async()=>({query:(sql:string,values?:unknown[])=>initialized.instance.client.query(sql,values),release(){}}),on(){},end:lookupEnd})) as never});
 await insertContainer(db,{handle:'owner',clerkUserId:ownerId,containerId:'fixture',port:5001,shellPort:6001,status:'running'});
 await insertUserMachine(db,{machineId,clerkUserId:ownerId,handle,runtimeSlot,status:'running',hetznerServerId:100,publicIPv4:'203.0.113.20',imageVersion:'dev',serverType:'cpx22',provisionedAt:'2026-10-31T00:00:00.000Z'});
 const orchestrator={provision:vi.fn(),start:vi.fn(),stop:vi.fn(),destroy:vi.fn(),upgrade:vi.fn(),rollingRestart:vi.fn(),getInfo:vi.fn(),getImage:vi.fn(),listAll:vi.fn(async()=>[]),syncStates:vi.fn()} as unknown as Orchestrator;
 app=createApp({db,orchestrator,platformSecret:secret,browserApprovalMachineLookup:lookup,clerkAuth:createClerkAuth({verifyToken:async token=>{const{payload}=await jwtVerify(token,jwtKey,{algorithms:['HS256'],issuer:'fixture-clerk'});return{...payload,sub:payload.sub!};}})});
 clerkToken=await new SignJWT({sid:'sess_owner'}).setProtectedHeader({alg:'HS256'}).setSubject(ownerId).setIssuer('fixture-clerk').setExpirationTime('2m').sign(jwtKey);
 received=undefined;vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{received=new Headers(init?.headers);return Response.json({accepted:true});});
});
afterEach(async()=>{await app.shutdownBrowserApprovals?.();expect(lookupEnd).not.toHaveBeenCalled();await lookup.close();expect(lookupEnd).toHaveBeenCalledOnce();await app.shutdownPostHog();vi.restoreAllMocks();vi.unstubAllEnvs();await destroyTestPlatformDb(db);});
async function proxy(path:string,body:object,explicit=true,token=clerkToken){received=undefined;const response=await app.request(`${explicit?`/vm/${handle}`:''}${path}`,{method:'POST',headers:{host:'app.matrix-os.com',authorization:`Bearer ${token}`,'content-type':'application/json',[ROUTINE_FULL_ACCESS_SCOPE_HEADER]:scopeId,[ROUTINE_FULL_ACCESS_PROOF_HEADER]:'spoof-full',[creationHeader]:'spoof-creation',[originHeader]:'spoof-origin'},body:JSON.stringify(body)});expect(response.status).toBe(200);return received!;}
function verify(kind:'origin'|'full',proof:string,tuple:object){return app.request(`/internal/containers/${handle}/${kind==='origin'?'routine-origin':'routine-full-access'}/verify`,{method:'POST',headers:{authorization:`Bearer ${buildPlatformVerificationToken(handle,secret)}`,[kind==='origin'?(('purpose' in tuple && tuple.purpose==='routine_creation_route')?creationHeader:originHeader):ROUTINE_FULL_ACCESS_PROOF_HEADER]:proof},body:JSON.stringify(tuple)});}
function creationTuple(path:string,body=turn){return{purpose:'routine_creation_route',handle,ownerId,machineId,runtimeSlot,sourceChatId,method:'POST',path,routineCreation:'matrix',clientRequestId:body.clientRequestId,baseRevision:body.baseRevision,bodyDigest:createHash('sha256').update(canonicalChatTurnRequestIdentity(body)).digest('hex')};}
function fullTuple(body=turn){return{kind:'turn',handle,ownerId,machineId,runtimeSlot,chatId:sourceChatId,scopeId,clientRequestId:body.clientRequestId,requestDigest:createHash('sha256').update(routineFullAccessTurnRequestIdentity(body)).digest('hex')};}
it('mints and forwards both distinct proofs on the same exact browser turn through explicit and selected-Computer proxy paths',async()=>{
 const path=`/api/chats/${sourceChatId}/turns`;
 for(const explicit of [true,false]){const headers=await proxy(path,turn,explicit);const full=headers.get(ROUTINE_FULL_ACCESS_PROOF_HEADER),creation=headers.get(creationHeader);
  expect(full).toEqual(expect.any(String));expect(full).not.toBe('spoof-full');expect(creation).toEqual(expect.any(String));expect(creation).not.toBe('spoof-creation');expect(headers.get(originHeader)).toBeNull();
  expect((await verify('full',full!,fullTuple())).status).toBe(200);const decision=await verify('origin',creation!,creationTuple(path));expect(decision.status).toBe(200);expect(await decision.json()).toMatchObject({verified:{purpose:'routine_creation_route',sessionId:'sess_owner'}});
 }
});
it('keeps a legacy omitted-field Full Access browser turn unchanged',async()=>{
 const{routineCreation:_,...legacy}=turn;const headers=await proxy(`/api/chats/${sourceChatId}/turns`,legacy);
 expect(headers.get(creationHeader)).toBeNull();expect(headers.get(originHeader)).toBeNull();const full=headers.get(ROUTINE_FULL_ACCESS_PROOF_HEADER)!;
 expect((await verify('full',full,fullTuple(legacy as typeof turn))).status).toBe(200);
 expect(canonicalChatTurnRequestIdentity(legacy)).toBe(JSON.stringify({parts:legacy.parts,selection:legacy.selection,interactionMode:legacy.interactionMode,permissionMode:legacy.permissionMode,executionRoot:null}));
});
it('strips caller proofs on device, unrelated, and unknown-Computer paths',async()=>{
 const token=await issueSyncJwt({clerkUserId:ownerId,handle,runtimeSlot,gatewayUrl:`https://${handle}.matrix-os.com`,sessionProvenance:'clerk-device',secret:'synthetic-sync-session-key-at-least-32-chars'});
 for(const path of [`/api/chats/${sourceChatId}/turns`,'/api/unrelated']){const headers=await proxy(path,turn,true,token.token);expect(headers.get(creationHeader)).toBeNull();expect(headers.get(originHeader)).toBeNull();expect(headers.get(ROUTINE_FULL_ACCESS_PROOF_HEADER)).toBeNull();}
});
it('registers distinct source approval verification in the production app and binds exact tuple and current SQL machine',async()=>{
 const path=`/api/chats/${sourceChatId}/routine-origin/${interactionId}/resolve`,headers=await proxy(path,originBody),proof=headers.get(originHeader);
 expect(proof).toEqual(expect.any(String));expect(proof).not.toBe('spoof-origin');expect(headers.get(creationHeader)).toBeNull();expect(headers.get(ROUTINE_FULL_ACCESS_PROOF_HEADER)).toBeNull();
 const tuple={...originBody,purpose:'routine_origin_approval',handle,ownerId,machineId,runtimeSlot,sourceChatId,interactionId,method:'POST',path,bodyDigest:createHash('sha256').update(JSON.stringify(originBody)).digest('hex')};
 expect((await verify('origin',proof!,tuple)).status).toBe(200);
 for(const patch of [{sourceChatId:'chat_other'},{decision:'deny'},{ownerId:'user_other'},{machineId:'machine_other'},{runtimeSlot:'other'}])expect((await verify('origin',proof!,{...tuple,...patch})).status).toBeGreaterThanOrEqual(400);
 await db.executor.updateTable('user_machines').set({clerk_user_id:'user_other'}).where('handle','=',handle).execute();expect((await verify('origin',proof!,tuple)).status).toBe(403);
});
it('keeps queue creation separate and rejects copied purposes, scope selectors and changed request bodies',async()=>{
 const path=`/api/chats/${sourceChatId}/turns`,headers=await proxy(path,turn),full=headers.get(ROUTINE_FULL_ACCESS_PROOF_HEADER)!,creation=headers.get(creationHeader)!;
 expect((await verify('origin',full,creationTuple(path))).status).toBe(403);
 expect((await verify('full',creation,fullTuple())).status).toBe(403);
 expect((await verify('full',full,{...fullTuple(),scopeId:`rcfull_${'c'.repeat(32)}`})).status).toBe(403);
 for(const changed of [{...turn,baseRevision:6},{...turn,clientRequestId:'req_copied'},{...turn,parts:[{type:'text' as const,text:'changed'}]}]){
  expect((await verify('origin',creation,creationTuple(path,changed))).status).toBe(403);
  expect((await verify('full',full,fullTuple(changed))).status).toBe(403);
 }
 const queuedPath=`/api/chats/${sourceChatId}/queued-turns`,queued=await proxy(queuedPath,turn);
 expect(queued.get(ROUTINE_FULL_ACCESS_PROOF_HEADER)).toBeNull();expect(queued.get(originHeader)).toBeNull();
 expect((await verify('origin',queued.get(creationHeader)!,creationTuple(queuedPath))).status).toBe(200);
 expect((await verify('origin',creation,creationTuple(queuedPath))).status).toBe(403);
});
it('strips new proof headers on the legacy container proxy without inventing a selected machine',async()=>{
 await db.executor.deleteFrom('user_machines').where('machine_id','=',machineId).execute();
 received=undefined;const response=await app.request(`/api/chats/${sourceChatId}/turns`,{method:'POST',headers:{host:'app.matrix-os.com',authorization:`Bearer ${clerkToken}`,'content-type':'application/json',[ROUTINE_FULL_ACCESS_SCOPE_HEADER]:scopeId,[creationHeader]:'spoof-creation',[originHeader]:'spoof-origin'},body:JSON.stringify(turn)});
 expect(response.status).toBe(200);expect(received?.get(creationHeader)).toBeNull();expect(received?.get(originHeader)).toBeNull();
});
