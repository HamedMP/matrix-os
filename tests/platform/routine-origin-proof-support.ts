import { vi } from 'vitest';
import { SignJWT, jwtVerify } from 'jose';
import { CanonicalCreateChatTurnRequestSchema } from '@matrix-os/contracts';
import { authenticatedRoutineOriginProxyProof } from '../../packages/platform/src/routine-origin-proxy.js';
import { createClerkAuth } from '../../packages/platform/src/clerk-auth.js';
import { createRoutineOriginVerificationRoutes } from '../../packages/platform/src/routine-origin-proof-routes.js';
import { routineBrowserTuple } from '../../packages/platform/src/routine-origin-proof.js';
import { buildPlatformVerificationToken } from '../../packages/platform/src/platform-token.js';
import { createRoutineOriginPlatformClient } from '../../packages/gateway/src/bots/routine-origin-platform-client.js';
const secret='fixture-purpose-signing-key',jwtKey=new TextEncoder().encode('fixture-jwt-auth-key-at-least-32-bytes');
const machine={machineId:'machine_one',handle:'owner-pc',runtimeSlot:'primary',provisioningClass:'customer' as const,clerkUserId:'user_owner',status:'running' as const};
const identity={handle:machine.handle,userId:machine.clerkUserId,runtimeSlot:machine.runtimeSlot,source:'auth' as const};
const originPath='/api/chats/chat_source/routine-origin/in_origin001/resolve';
const body={kind:'approval' as const,baseRevision:2,decision:'approve' as const};
const turn=CanonicalCreateChatTurnRequestSchema.parse({clientRequestId:'req_policy',baseRevision:1,parts:[{type:'text',text:'Schedule'}],selection:{instanceId:'claude_code_default',model:'model'},interactionMode:'default',permissionMode:'supervised',routineCreation:'matrix'});
const clerkAuth=createClerkAuth({verifyToken:async token=>{const {payload}=await jwtVerify(token,jwtKey,{algorithms:['HS256'],issuer:'fixture-clerk'});return {...payload,sub:payload.sub!};}});
async function fixture(path=originPath,payload:object=body,claims:{sub?:string;sid?:string;exp?:number}={}) {
 const token=await new SignJWT({sid:claims.sid??'sess_owner'}).setProtectedHeader({alg:'HS256'}).setSubject(claims.sub??identity.userId).setIssuer('fixture-clerk').setExpirationTime(claims.exp??Math.floor(Date.now()/1000)+120).sign(jwtKey);
 const proof=await authenticatedRoutineOriginProxyProof({request:new Request(`https://app.example.test${path}`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(payload)}),method:'POST',path,handle:machine.handle,identity,machine,clerkAuth,platformSecret:secret});
 const tuple=routineBrowserTuple({method:'POST',path,body:JSON.stringify(payload),handle:machine.handle,runtimeSlot:machine.runtimeSlot,machineId:machine.machineId,ownerId:identity.userId});
 return {proof,tuple};
}
function transport(patch:Partial<typeof machine>={}) {
 const lookup={resolveMachine:vi.fn(async()=>({...machine,...patch}))};
 const app=createRoutineOriginVerificationRoutes({platformSecret:secret,lookup:lookup as never});
 const client=createRoutineOriginPlatformClient({platformUrl:'https://platform.test',handle:machine.handle,token:buildPlatformVerificationToken(machine.handle,secret),fetcher:async(url,init)=>app.fetch(new Request(url,init))});
 return {app,client,lookup};
}
export { secret,jwtKey,machine,identity,originPath,body,turn,clerkAuth,fixture,transport };
