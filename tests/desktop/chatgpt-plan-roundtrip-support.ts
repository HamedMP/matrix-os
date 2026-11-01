import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportJWK, SignJWT } from 'jose';
import { expect, vi } from 'vitest';
import { chatGptPlanPeerRequestId, chatGptPlanPeerProof, type ChatGptPlanPeerRequest } from '@matrix-os/contracts';
import { createNativeChatgptPlanService } from '../../desktop/src/main/chatgpt-plan/service';
import { createPlanVault } from '../../desktop/src/main/chatgpt-plan/vault';
export const session={runtimeSlot:'primary',authGeneration:1};
const scope='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const pair=generateKeyPairSync('rsa',{modulusLength:2048});
async function tokens(clientId:string,nonce:string|undefined,subject='subject',expiresIn=300) {
 const access=await new SignJWT({client_id:clientId,scope}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer('https://auth.openai.com').setAudience('https://api.openai.com/v1').setSubject(subject).setExpirationTime('1h').sign(pair.privateKey);
 const id=await new SignJWT({...(nonce?{nonce}:{}),email:'user@example.test'}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer('https://auth.openai.com').setAudience(clientId).setSubject(subject).setExpirationTime('1h').sign(pair.privateKey);
 return {access_token:access,refresh_token:'fixture-refresh',id_token:id,token_type:'Bearer',scope,expires_in:expiresIn};
}
export async function fixture(runtimeSlot='primary', approvedRoutines=false) {
 const dir=await mkdtemp(join(tmpdir(),'matrix-native-plan-'));
 const vault=createPlanVault({dir,safeStorage:{isEncryptionAvailable:()=>true,encryptString:x=>Buffer.from(x).reverse(),decryptString:x=>Buffer.from(x).reverse().toString()}});
 const localSession={...session,runtimeSlot};
 const authState={...localSession,signedIn:true as const,userId:'owner',handle:'computer',platformHost:'https://matrix.test'};
 let authUrl:URL|undefined;let browserOpens=0;let rejectNonce=false;let expiresIn=300;
 let jwksGate:Promise<void>|null=null;let releaseJwks:()=>void=()=>{};let jwksHeld=false;
 let catalogOverride:{gate:Promise<void>;fail:boolean|401;model:string}|null=null;let responseGate:Promise<void>|null=null;let releaseResponse:()=>void=()=>{};let responseAborted=false;
 let disconnectGate:Promise<void>|null=null;
 let deviceConflict=false;let rebinds=0;let normalConnectFailure=false;
 let replacementFailure:{commit:boolean;lost:boolean;gate?:Promise<void>;failProbe?:boolean}|null=null;
 let catalogStatus:number|null=null;let refreshError:string|null=null;
 let rejectCatalog=false;let visibleModel='fixture-visible';let catalogGate:Promise<void>|null=null;let releaseCatalog:()=>void=()=>{};let refreshGate:Promise<void>|null=null;let releaseRefresh:()=>void=()=>{};let lateFailure=false;
 const snapshots:unknown[]=[];const replies:Array<Record<string,unknown>>=[];const providerBodies:unknown[]=[];
 let queued:ChatGptPlanPeerRequest[]=[];let refreshes=0;let polls=0;let revoked=false;
 const fetchFn=vi.fn(async(input: string|URL|Request,init?:RequestInit):Promise<Response>=>{
  const url=new URL(String(input));
  if(url.hostname==='matrix.test')expect(url.searchParams.get('runtime')).toBe(authState.runtimeSlot==='primary'?null:authState.runtimeSlot);
  else expect(url.searchParams.has('runtime')).toBe(false);
  const json=(x:unknown)=>Response.json(x);
  if(url.pathname==='/.well-known/jwks.json'){if(jwksGate){jwksHeld=true;await jwksGate;}return json({keys:[{...await exportJWK(pair.publicKey),kid:'test',alg:'RS256'}]});}
  if(url.pathname==='/api/accounts/oauth/token'){
   const form=new URLSearchParams(String(init?.body));
   expect(form.get('client_id')).toBe('oaiapp_matrix_fixture');
   if(form.get('grant_type')==='refresh_token'){refreshes++;if(refreshError)return Response.json({error:refreshError,error_description:'private fixture diagnostic'},{status:400});if(refreshGate)await refreshGate;expect(form.has('scope')).toBe(false);return json(await tokens('oaiapp_matrix_fixture',undefined,'subject',300));}
   expect(form.get('redirect_uri')).toBe(authUrl?.searchParams.get('redirect_uri'));expect(form.get('code_verifier')).toBeTruthy();
   return json(await tokens('oaiapp_matrix_fixture',rejectNonce?'wrong':authUrl?.searchParams.get('nonce')??undefined,'subject',expiresIn));
  }
  if(url.pathname==='/v1/models'){const override=catalogOverride;catalogOverride=null;if(override)await override.gate;if(catalogGate)await catalogGate;if(override?.fail===401||catalogStatus)return Response.json({error:{code:'invalid_api_key',message:'private fixture diagnostic'}},{status:override?.fail===401?401:catalogStatus!});if(override?.fail||rejectCatalog)throw new Error('catalog unavailable');return json({models:[{slug:override?.model??visibleModel,display_name:'Visible fixture',visibility:'list'},{slug:'fixture-hidden',display_name:'Hidden',visibility:'hidden'}]});}
  if(url.pathname==='/v1/responses'){
   providerBodies.push(JSON.parse(String(init?.body)));expect(init?.headers).toHaveProperty('authorization');
   if(responseGate){const gate=responseGate;return new Response(new ReadableStream<Uint8Array>({
    start(controller){controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"pending"}\n\n'));void gate.then(()=>{if(responseAborted)return;controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"status":"completed","model":"fixture-visible"}}\n\n'));controller.close();});},
    cancel(){responseAborted=true;},
   }),{headers:{'content-type':'text/event-stream'}});}
   return new Response((lateFailure?'data: {"type":"response.failed"}\n\n':'')+'data: {"type":"response.output_text.delta","delta":"fixture"}\n\ndata: {"type":"response.completed","response":{"status":"completed","model":"fixture-visible"}}\n\n',{headers:{'content-type':'text/event-stream'}});
  }
  if(url.pathname==='/.well-known/openid-configuration')return json({revocation_endpoint:'https://auth.openai.com/api/accounts/oauth/revoke'});
  if(url.pathname==='/api/accounts/oauth/revoke'){revoked=true;return new Response(null,{status:200});}
  if(url.pathname==='/api/chatgpt-plan/device/rebind-challenge'){rebinds++;return json({version:1,challenge:'b'.repeat(64),ownerId:authState.userId,computerId:authState.handle,expiresAt:new Date(Date.now()+60000).toISOString(),replacement:{expectedDeviceId:'f'.repeat(64)}});}
  if(url.pathname==='/api/chatgpt-plan/device/challenge')return json({version:1,challenge:'a'.repeat(64),ownerId:authState.userId,computerId:authState.handle,expiresAt:new Date(Date.now()+60000).toISOString()});
  if(url.pathname==='/api/chatgpt-plan/device/connect'){
   const body=JSON.parse(String(init?.body));snapshots.push(body.snapshot);
   const proof=chatGptPlanPeerProof({challenge:body.challenge,ownerId:authState.userId,computerId:authState.handle,snapshot:body.snapshot,...(body.replacement?{replacement:body.replacement}:{})});
   expect(verify(null,Buffer.from(proof),createPublicKey({key:Buffer.from(body.publicKey,'base64url'),type:'spki',format:'der'}),Buffer.from(body.signature,'base64url'))).toBe(true);
   expect(JSON.stringify(body)).not.toContain('accessToken');expect(JSON.stringify(body)).not.toContain('refreshToken');
   if(!body.replacement&&normalConnectFailure){normalConnectFailure=false;return Response.json({code:'unavailable'},{status:503});}
   if(deviceConflict&&!body.replacement)return Response.json({code:'conflict'},{status:409});
   if(body.replacement){
    const failure=replacementFailure;replacementFailure=null;
    if(!failure||failure.commit)deviceConflict=false;
    if(failure){normalConnectFailure=Boolean(failure.failProbe);if(failure.gate)await failure.gate;if(failure.lost)throw new Error('lost replacement response');return Response.json({code:'unavailable'},{status:503});}
   }
   return json({version:1,sessionId:'00000000-0000-4000-8000-000000000001'});
  }
  if(url.pathname==='/api/chatgpt-plan/device/capabilities')return json({version:1,sessionId:'00000000-0000-4000-8000-000000000001',pollDeliveryVersion:2,...(approvedRoutines&&url.searchParams.get('includeApprovedRoutines')==='true'?{approvedRoutines:true}:{})});
  if(url.pathname==='/api/chatgpt-plan/device/poll-v2'){
   const receipt=JSON.parse(String(init?.body));
   expect(receipt.version).toBe(2);expect(receipt.sessionId).toBe('00000000-0000-4000-8000-000000000001');
   polls++;
   await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new DOMException('cancelled','AbortError'));};const timer=setTimeout(()=>{init?.signal?.removeEventListener('abort',abort);resolve();},15);init?.signal?.addEventListener('abort',abort,{once:true});});
   const requests=queued;queued=[];return json({version:2,sessionId:receipt.sessionId,acknowledgedThrough:receipt.ackThrough,
    deliveries:requests.map((request,i)=>({deliverySequence:receipt.ackThrough+i+1,request}))});
  }
  if(url.pathname==='/api/chatgpt-plan/device/reply'){replies.push(JSON.parse(String(init?.body)));return json({version:1,ok:true});}
  if(url.pathname==='/api/chatgpt-plan/device/disconnect'){const gate=disconnectGate;disconnectGate=null;if(gate)await gate;return json({ok:true});}
  throw new Error('unexpected fixture endpoint');
 });
 const service=createNativeChatgptPlanService({vault,auth:{getStatus:()=>authState,getToken:()=> 'fixture-matrix-bearer',getGatewayOrigin:()=> 'https://matrix.test'},openBrowser:async url=>{browserOpens++;authUrl=new URL(url);},fetchFn});
 async function finish(){const callback=new URL(authUrl!.searchParams.get('redirect_uri')!);callback.searchParams.set('state',authUrl!.searchParams.get('state')!);callback.searchParams.set('code','fixture-code');callback.searchParams.set('client_id','oaiapp_matrix_fixture');expect((await fetch(callback)).status).toBe(200);}
 async function signedIn(){await service.connect({...localSession,purpose:'personal_local'});await finish();await vi.waitFor(async()=>expect((await service.status(localSession)).bridgeConnected).toBe(true));}
 return {service,vault,authState,conflict:()=>{deviceConflict=true;},failReplacement:(failure:NonNullable<typeof replacementFailure>)=>{replacementFailure=failure;},get rebinds(){return rebinds;},snapshots,catalogStatus:(value:number|null)=>{catalogStatus=value;},refreshError:(value:string|null)=>{refreshError=value;},holdDisconnect:()=>{let release:()=>void=()=>{};disconnectGate=new Promise<void>(resolve=>{release=resolve;});return release;},clearRequests:()=>{queued=[];},allowCatalog:()=>{rejectCatalog=false;},holdOneCatalog:(fail:boolean|401=false,model=visibleModel)=>{let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});catalogOverride={gate,fail,model};return release;},holdResponse:()=>{responseGate=new Promise<void>(resolve=>{releaseResponse=()=>{responseGate=null;resolve();};});return ()=>releaseResponse();},get responseAborted(){return responseAborted;},replies,providerBodies,fetchFn,finish,signedIn,queue:(items:ChatGptPlanPeerRequest[])=>{queued.push(...items);},changeModel:(model:string)=>{visibleModel=model;},holdCatalog:()=>{catalogGate=new Promise(resolve=>{releaseCatalog=()=>{catalogGate=null;resolve();};});return ()=>releaseCatalog();},holdRefresh:()=>{refreshGate=new Promise(resolve=>{releaseRefresh=()=>{refreshGate=null;resolve();};});return ()=>releaseRefresh();},lateFailure:()=>{lateFailure=true;},rejectNonce:()=>{rejectNonce=true;},expireSoon:()=>{expiresIn=1;},holdJwks:()=>{jwksHeld=false;jwksGate=new Promise(resolve=>{releaseJwks=()=>{jwksGate=null;resolve();};});return ()=>releaseJwks();},rejectCatalog:()=>{rejectCatalog=true;},get browserOpens(){return browserOpens;},get jwksHeld(){return jwksHeld;},get refreshes(){return refreshes;},get polls(){return polls;},get revoked(){return revoked;},cleanup:async()=>{await service.dispose();await rm(dir,{recursive:true,force:true});}};
}
export function request(id:string,accountId:string,grantRevision:number):ChatGptPlanPeerRequest {
 const sequence=Number.parseInt(id.slice(-12),16);
 return {version:1,action:'infer',id:chatGptPlanPeerRequestId('00000000-0000-4000-8000-000000000001',sequence),sequence,expiresAt:new Date(Date.now()+120000).toISOString(),accountId,grantRevision,computerId:'computer',runId:'run_fixture',requestClass:'interactive',model:'fixture-visible',body:JSON.stringify({model:'fixture-visible',input:[{role:'user',content:'fixture only'}],store:false,stream:true})};
}
