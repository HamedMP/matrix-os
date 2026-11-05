import { describe, expect, it } from 'vitest';
import { CanonicalCreateChatTurnRequestSchema, canonicalChatTurnRequestIdentity } from '@matrix-os/contracts';
import { authenticatedRoutineOriginProxyProof } from '../../packages/platform/src/routine-origin-proxy.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { shouldForwardProxyHeader } from '../../packages/platform/src/session-routing-proxy.js';
const input = { clientRequestId:'req_origin_policy',baseRevision:1,parts:[{type:'text' as const,text:'Schedule'}], selection:{instanceId:'claude_code_default',model:'claude-sonnet-4-6'},interactionMode:'default',permissionMode:'supervised' };
const machine={machineId:'machine_one',handle:'owner-pc',runtimeSlot:'primary',provisioningClass:'customer' as const,clerkUserId:'user_owner'};
const identity={handle:machine.handle,userId:machine.clerkUserId,runtimeSlot:machine.runtimeSlot,source:'auth' as const};
const clerkAuth=createClerkAuth({verifyToken:async token=>{if(token==='clerk-session')return{sub:'user_owner',sid:'sess_owner',exp:Math.floor(Date.now()/1000)+120};throw new Error('Not Clerk');}});
export async function proxyProof(path:string,body:object,token='clerk-session') {return authenticatedRoutineOriginProxyProof({request:new Request(`https://app.example.test${path}`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(body)}),method:'POST',path,handle:machine.handle,identity,machine,clerkAuth,platformSecret:'fixture-secret'});}
export {input,machine,identity,clerkAuth};
describe('request-bound routine creation policy',()=>{
 it('accepts explicit Matrix selection while changing the old request identity only when present',()=>{
  expect(CanonicalCreateChatTurnRequestSchema.safeParse({...input,routineCreation:'matrix'}).success).toBe(true);
  const legacy=JSON.stringify({parts:input.parts,selection:input.selection,interactionMode:input.interactionMode,permissionMode:input.permissionMode,executionRoot:null});
  expect(canonicalChatTurnRequestIdentity(input)).toBe(legacy);
  expect(canonicalChatTurnRequestIdentity({...input,routineCreation:'matrix'})).not.toBe(legacy);
 });
 it('mints the distinct browser creation purpose on the same turn submit',async()=>{
  expect(await proxyProof('/api/chats/chat_source/turns',{...input,routineCreation:'matrix'})).toEqual(expect.any(String));
 });
 it('mints browser origin approval for the real source selector',async()=>{
  expect(await proxyProof('/api/chats/chat_source/routine-origin/in_origin001/resolve',{kind:'approval',baseRevision:2,decision:'approve'})).toEqual(expect.any(String));
 });
 it('strips both user-supplied purpose proof headers',()=>{
  for(const key of ['x-matrix-routine-origin-proof','x-matrix-routine-creation-proof']) expect(shouldForwardProxyHeader(key,'spoof')).toBe(false);
 });
});
