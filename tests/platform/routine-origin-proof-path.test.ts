import { describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { ROUTINE_CREATION_PROOF_HEADER, ROUTINE_ORIGIN_PROOF_HEADER, type RoutineBrowserTuple } from '@matrix-os/contracts';
import { authenticatedApprovalProxyProof } from '../../packages/platform/src/canonical-owner-approval-proxy.js';
import { createRoutineOriginVerificationRoutes } from '../../packages/platform/src/routine-origin-proof-routes.js';
import { verifyRoutineBrowserProof } from '../../packages/platform/src/routine-origin-proof.js';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { browserApprovalProofHeader } from '../../packages/platform/src/browser-chat-approval-proof.js';
import { createRoutineOriginRoutes } from '../../packages/gateway/src/bots/routine-origin-routes.js';
import { createRoutineCreationAdmission } from '../../packages/gateway/src/chat/routine-creation-policy.js';
import { secret,jwtKey,machine,identity,originPath,body,turn,clerkAuth,fixture,transport } from './routine-origin-proof-support.js';
describe('real typed Clerk JWT -> proxy HMAC -> internal Hono verifier -> Gateway client',()=>{
 it('verifies browser decision and carries the actual session ID, exact purpose and bounded nonce',async()=>{
  const {proof,tuple}=await fixture();expect(typeof proof).toBe('string');expect(tuple?.purpose).toBe('routine_origin_approval');
  if(typeof proof!=='string'||tuple?.purpose!=='routine_origin_approval')throw new Error('proof fixture unavailable');
  const verified=await transport().client.verifyApproval(tuple,proof);
  expect(verified).toMatchObject({sessionId:'sess_owner',purpose:'routine_origin_approval',sourceChatId:'chat_source',interactionId:'in_origin001'});
  expect(verified.expiresAt-verified.issuedAt).toBeLessThanOrEqual(60_000);expect(verified.nonce).toMatch(/^[a-f0-9]{32}$/);
  expect(browserApprovalProofHeader(proof)).toBe(ROUTINE_ORIGIN_PROOF_HEADER);
 });
 it('binds every decision field and refuses copied, expired and wrong-purpose proofs',async()=>{
  const {proof,tuple}=await fixture();if(typeof proof!=='string'||!tuple)throw new Error('proof fixture unavailable');
  for(const patch of [{sourceChatId:'chat_foreign'},{interactionId:'in_foreign01'},{ownerId:'user_foreign'},{machineId:'machine_other'},{runtimeSlot:'other'},{baseRevision:3},{decision:'deny'},{bodyDigest:'b'.repeat(64)},{purpose:'routine_creation_route'}])
   expect(verifyRoutineBrowserProof(proof,{...tuple,...patch} as RoutineBrowserTuple,secret)).toBeNull();
  expect(verifyRoutineBrowserProof(proof,tuple,secret,Date.now()+60_001)).toBeNull();
  expect(verifyRoutineBrowserProof(proof,tuple,'wrong-secret')).toBeNull();
 });
 it('does not mint for device JWTs, owner-only JWTs, expired/invalid Clerk or cross-owner Clerk',async()=>{
  expect((await fixture(originPath,body,{sub:'user_foreign'})).proof).toBeNull();
  expect((await fixture(originPath,body,{exp:1})).proof).toBeNull();
  for(const token of ['device-jwt',await new SignJWT({}).setProtectedHeader({alg:'HS256'}).setSubject(identity.userId).setIssuer('fixture-clerk').setExpirationTime('2m').sign(jwtKey)]) {
   const proof=await authenticatedApprovalProxyProof({request:new Request(`https://app.test${originPath}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'x-matrix-native-client':'matrix-os-desktop'},body:JSON.stringify(body)}),method:'POST',path:originPath,handle:machine.handle,identity:{...identity,sessionProvenance:'clerk-device'},machine,clerkAuth,platformSecret:secret});
   expect(proof).toBeNull();
  }
 });
 it('verifies current machine ownership/slot again over authenticated internal transport',async()=>{
  const {proof,tuple}=await fixture();if(typeof proof!=='string'||tuple?.purpose!=='routine_origin_approval')throw new Error('proof fixture unavailable');
  for(const patch of [{clerkUserId:'user_other'},{machineId:'machine_other'},{runtimeSlot:'wrong'},{status:'stopped'}])
   await expect(transport(patch as never).client.verifyApproval(tuple,proof)).rejects.toThrow('unavailable');
  const response=await transport().app.request('/internal/containers/owner-pc/routine-origin/verify',{method:'POST',headers:{[ROUTINE_ORIGIN_PROOF_HEADER]:proof},body:JSON.stringify(tuple)});
  expect(response.status).toBe(401);
 });
 it('attests the exact turn/queue creation identity and refuses creation proof reused for origin',async()=>{
  const {proof,tuple}=await fixture('/api/chats/chat_source/queued-turns',turn);
  if(typeof proof!=='string'||tuple?.purpose!=='routine_creation_route')throw new Error('proof fixture unavailable');
  const {client}=transport();const verified=await client.verifyCreation(tuple,proof);expect(verified.purpose).toBe('routine_creation_route');
  expect(browserApprovalProofHeader(proof)).toBe(ROUTINE_CREATION_PROOF_HEADER);
  const before=createRoutineCreationAdmission({...machine,verifyCreation:client.verifyCreation});
  await expect(before({principal:{userId:identity.userId,source:'jwt'},owner:{type:'personal',ownerId:identity.userId},chatId:'chat_source',body:turn,proof,path:'queued-turns'})).resolves.toBeUndefined();
  for(const changed of [{...turn,parts:[{type:'text' as const,text:'changed'}]},{...turn,baseRevision:2}])
   await expect(before({principal:{userId:identity.userId,source:'jwt'},owner:{type:'personal',ownerId:identity.userId},chatId:'chat_source',body:changed,proof,path:'queued-turns'})).rejects.toThrow();
  const origin=await fixture();await expect(client.verifyApproval(origin.tuple as never,proof)).rejects.toThrow();
 });
 it('rejects direct Gateway mutation before invoking the atomic service',async()=>{
  const resolve=vi.fn();const {client}=transport();
  const app=createRoutineOriginRoutes({service:{read:vi.fn(),resolve},verifyApproval:client.verifyApproval,...machine,getPrincipal:()=>({userId:identity.userId,source:'jwt'}),admitContinuation:vi.fn()});
  const response=await app.request(originPath,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  expect(response.status).toBe(403);expect(resolve).not.toHaveBeenCalled();expect(response.headers.get('cache-control')).toBe('private, no-store');
 });
});
it('the actual Gateway route forwards only a verified exact browser decision to the service',async()=>{
 const {proof}=await fixture();if(typeof proof!=='string')throw new Error('proof fixture unavailable');
 const response={interaction:{interactionId:'in_origin001',status:'resolved' as const,revision:3}};
 const resolve=vi.fn(async()=>({response}));const {client}=transport();
 const app=createRoutineOriginRoutes({service:{read:vi.fn(),resolve},verifyApproval:client.verifyApproval,...machine,getPrincipal:()=>({userId:identity.userId,source:'jwt'}),admitContinuation:vi.fn()});
 const result=await app.request(originPath,{method:'POST',headers:{'content-type':'application/json',[ROUTINE_ORIGIN_PROOF_HEADER]:proof},body:JSON.stringify(body)});
 expect(result.status).toBe(200);expect(await result.json()).toEqual(response);
 expect(resolve).toHaveBeenCalledWith(identity.userId,'chat_source','in_origin001',body,expect.objectContaining({sessionId:'sess_owner',purpose:'routine_origin_approval',machineId:machine.machineId}));
});
it('authenticates internal callers before body collection and bounds slow/large bodies with safe errors',async()=>{
 const app=createRoutineOriginVerificationRoutes({platformSecret:secret,lookup:{resolveMachine:vi.fn()} as never,bodyTimeoutMs:20});
 const path='/internal/containers/owner-pc/routine-origin/verify';
 const unauthorized=await app.fetch(new Request(`https://platform.test${path}`,{method:'POST',body:new ReadableStream({start(){}}),duplex:'half'} as RequestInit));
 expect(unauthorized.status).toBe(401);
 const slow=await app.fetch(new Request(`https://platform.test${path}`,{method:'POST',headers:{authorization:`Bearer ${buildPlatformVerificationToken(machine.handle,secret)}`},body:new ReadableStream({start(){}}),duplex:'half'} as RequestInit));
 expect(slow.status).toBe(408);expect(slow.headers.get('cache-control')).toBe('private, no-store');
 const large=await app.request(path,{method:'POST',headers:{authorization:`Bearer ${buildPlatformVerificationToken(machine.handle,secret)}`},body:'x'.repeat(4001)});
 expect(large.status).toBe(413);
});
it('uses a separately verified Clerk session for an owned Preview Computer with legacy routing provenance',async()=>{
 const preview={...machine,handle:'pr-1234',runtimeSlot:'pr-1234',provisioningClass:'preview' as const};
 const token=await new SignJWT({sid:'sess_owner'}).setProtectedHeader({alg:'HS256'}).setSubject(identity.userId).setIssuer('fixture-clerk').setExpirationTime('2m').sign(jwtKey);
 const signed=await authenticatedApprovalProxyProof({request:new Request(`https://app.test${originPath}`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(body)}),method:'POST',path:originPath,handle:preview.handle,identity:{...identity,handle:'legacy-pc'},machine:preview,clerkAuth,platformSecret:secret});
 expect(signed).toEqual(expect.any(String));
});
it('does not accept the existing exact-operation approval purpose as a source activation proof',async()=>{
 const {mintRoutineActionProof}=await import('../../packages/platform/src/routine-action-proof.js');
 const prior=mintRoutineActionProof({method:'POST',path:`/api/routine-cli/actions/rcact_${'a'.repeat(32)}/decision`,body:JSON.stringify({actionDigest:'b'.repeat(64),decision:'approve',clientRequestId:'de000000-0000-4000-8000-000000000001'}),secret,handle:machine.handle,runtimeSlot:machine.runtimeSlot,machineId:machine.machineId,ownerId:identity.userId,sessionExpiresAt:Date.now()+60_000});
 const {tuple}=await fixture();expect(prior).toEqual(expect.any(String));expect(verifyRoutineBrowserProof(prior!,tuple!,secret)).toBeNull();
});
it('reports a committed decision with unconfirmed continuation instead of claiming completion',async()=>{
 const {proof}=await fixture();if(typeof proof!=='string')throw new Error('proof fixture unavailable');
 const response={interaction:{interactionId:'in_origin001',status:'resolved' as const,revision:3}};
 const service={read:vi.fn(),resolve:vi.fn(async()=>({response,continuation:{chatId:'chat_canonical',clientRequestId:'req_continuation',text:'Approved'}}))};
 const app=createRoutineOriginRoutes({service,verifyApproval:transport().client.verifyApproval,...machine,getPrincipal:()=>({userId:identity.userId,source:'jwt'}),admitContinuation:vi.fn(async()=>{throw new Error('uncertain');})});
 const result=await app.request(originPath,{method:'POST',headers:{[ROUTINE_ORIGIN_PROOF_HEADER]:proof},body:JSON.stringify(body)});
 expect(result.status).toBe(200);expect(await result.json()).toEqual({...response,continuationPending:true});
});
it('refuses a verifier response for a different original proof of the same decision', async () => {
  const original = await fixture(), replacement = await fixture(originPath, body, { sid: 'sess_another_browser' });
  if (typeof original.proof !== 'string' || typeof replacement.proof !== 'string' || original.tuple?.purpose !== 'routine_origin_approval')
    throw new Error('proof fixture unavailable');
  const { app } = transport(), otherProof = replacement.proof;
  const { createRoutineOriginPlatformClient } = await import('../../packages/gateway/src/bots/routine-origin-platform-client.js');
  const client = createRoutineOriginPlatformClient({ platformUrl: 'https://platform.test', handle: machine.handle,
    token: buildPlatformVerificationToken(machine.handle, secret), fetcher: async (url, init) => {
      const request = new Request(url, init);
      expect(request.headers.get(ROUTINE_ORIGIN_PROOF_HEADER)).toBe(original.proof);
      request.headers.set(ROUTINE_ORIGIN_PROOF_HEADER, otherProof);
      const response = await app.fetch(request);
      expect(response.status).toBe(200); // The replacement is independently authentic.
      return response;
    } });
  await expect(client.verifyApproval(original.tuple, original.proof)).rejects.toThrow('unavailable');
});
it('bounds repeated source reads and decision attempts by verified principal with independent budgets', async () => {
  let userId = identity.userId;
  const view = { sourceChatId: 'chat_source', pending: [], deliveries: [], hasMore: false, deliveryPending: false };
  const read = vi.fn(async () => view), resolve = vi.fn(), verifyApproval = vi.fn(async () => { throw new Error('invalid'); });
  const app = createRoutineOriginRoutes({ service: { read, resolve }, verifyApproval, ...machine,
    getPrincipal: () => ({ userId, source: 'jwt' }), admitContinuation: vi.fn() });
  const get = () => app.request('/api/chats/chat_source/routine-origin');
  const decide = () => app.request(originPath, { method: 'POST', headers: { [ROUTINE_ORIGIN_PROOF_HEADER]: 'invalid' }, body: JSON.stringify(body) });
  for (let i = 0; i < 120; i++) expect((await get()).status).toBe(200);
  expect((await get()).status).toBe(429);
  expect(read).toHaveBeenCalledTimes(120);
  for (let i = 0; i < 30; i++) expect((await decide()).status).toBe(403);
  expect((await decide()).status).toBe(429);
  expect(verifyApproval).toHaveBeenCalledTimes(30);
  expect(resolve).not.toHaveBeenCalled();
  userId = 'user_second';
  expect((await get()).status).toBe(200);
  expect((await decide()).status).toBe(403);
});
