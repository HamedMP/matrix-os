import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportJWK, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { chatGptPlanPeerRequestId, chatGptPlanPeerProof, type ChatGptPlanPeerRequest } from '@matrix-os/contracts';
import { createNativeChatgptPlanService } from '../../desktop/src/main/chatgpt-plan/service';
import { createPlanVault } from '../../desktop/src/main/chatgpt-plan/vault';
const session={runtimeSlot:'primary',authGeneration:1};
const scope='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const pair=generateKeyPairSync('rsa',{modulusLength:2048});
async function tokens(clientId:string,nonce:string|undefined,subject='subject',expiresIn=300) {
 const access=await new SignJWT({client_id:clientId,scope}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer('https://auth.openai.com').setAudience('https://api.openai.com/v1').setSubject(subject).setExpirationTime('1h').sign(pair.privateKey);
 const id=await new SignJWT({...(nonce?{nonce}:{}),email:'user@example.test'}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer('https://auth.openai.com').setAudience(clientId).setSubject(subject).setExpirationTime('1h').sign(pair.privateKey);
 return {access_token:access,refresh_token:'fixture-refresh',id_token:id,token_type:'Bearer',scope,expires_in:expiresIn};
}
async function fixture(runtimeSlot='primary') {
 const dir=await mkdtemp(join(tmpdir(),'matrix-native-plan-'));
 const vault=createPlanVault({dir,safeStorage:{isEncryptionAvailable:()=>true,encryptString:x=>Buffer.from(x).reverse(),decryptString:x=>Buffer.from(x).reverse().toString()}});
 const localSession={...session,runtimeSlot};
 const authState={...localSession,signedIn:true as const,userId:'owner',handle:'computer'};
 let authUrl:URL|undefined;let browserOpens=0;let rejectNonce=false;let expiresIn=300;
 let jwksGate:Promise<void>|null=null;let releaseJwks:()=>void=()=>{};let jwksHeld=false;
 let rejectCatalog=false;let visibleModel='fixture-visible';let catalogGate:Promise<void>|null=null;let releaseCatalog:()=>void=()=>{};let refreshGate:Promise<void>|null=null;let releaseRefresh:()=>void=()=>{};let lateFailure=false;
 const snapshots:unknown[]=[];const replies:Array<Record<string,unknown>>=[];const providerBodies:unknown[]=[];
 let queued:ChatGptPlanPeerRequest[]=[];let refreshes=0;let polls=0;let revoked=false;
 const fetchFn=vi.fn(async(input: string|URL|Request,init?:RequestInit):Promise<Response>=>{
  const url=new URL(String(input));
  if(url.hostname==='matrix.test')expect(url.searchParams.get('runtime')).toBe(runtimeSlot==='primary'?null:runtimeSlot);
  else expect(url.searchParams.has('runtime')).toBe(false);
  const json=(x:unknown)=>Response.json(x);
  if(url.pathname==='/.well-known/jwks.json'){if(jwksGate){jwksHeld=true;await jwksGate;}return json({keys:[{...await exportJWK(pair.publicKey),kid:'test',alg:'RS256'}]});}
  if(url.pathname==='/api/accounts/oauth/token'){
   const form=new URLSearchParams(String(init?.body));
   expect(form.get('client_id')).toBe('oaiapp_matrix_fixture');
   if(form.get('grant_type')==='refresh_token'){refreshes++;if(refreshGate)await refreshGate;expect(form.has('scope')).toBe(false);return json(await tokens('oaiapp_matrix_fixture',undefined,'subject',300));}
   expect(form.get('redirect_uri')).toBe(authUrl?.searchParams.get('redirect_uri'));expect(form.get('code_verifier')).toBeTruthy();
   return json(await tokens('oaiapp_matrix_fixture',rejectNonce?'wrong':authUrl?.searchParams.get('nonce')??undefined,'subject',expiresIn));
  }
  if(url.pathname==='/v1/models'){if(catalogGate)await catalogGate;if(rejectCatalog)throw new Error('catalog unavailable');return json({models:[{slug:visibleModel,display_name:'Visible fixture',visibility:'list'},{slug:'fixture-hidden',display_name:'Hidden',visibility:'hidden'}]});}
  if(url.pathname==='/v1/responses'){
   providerBodies.push(JSON.parse(String(init?.body)));expect(init?.headers).toHaveProperty('authorization');
   return new Response((lateFailure?'data: {"type":"response.failed"}\n\n':'')+'data: {"type":"response.output_text.delta","delta":"fixture"}\n\ndata: {"type":"response.completed","response":{"status":"completed","model":"fixture-visible"}}\n\n',{headers:{'content-type':'text/event-stream'}});
  }
  if(url.pathname==='/.well-known/openid-configuration')return json({revocation_endpoint:'https://auth.openai.com/api/accounts/oauth/revoke'});
  if(url.pathname==='/api/accounts/oauth/revoke'){revoked=true;return new Response(null,{status:200});}
  if(url.pathname==='/api/chatgpt-plan/device/challenge')return json({version:1,challenge:'a'.repeat(64),ownerId:'owner',computerId:'computer',expiresAt:new Date(Date.now()+60000).toISOString()});
  if(url.pathname==='/api/chatgpt-plan/device/connect'){
   const body=JSON.parse(String(init?.body));snapshots.push(body.snapshot);
   const proof=chatGptPlanPeerProof({challenge:body.challenge,ownerId:'owner',computerId:'computer',snapshot:body.snapshot});
   expect(verify(null,Buffer.from(proof),createPublicKey({key:Buffer.from(body.publicKey,'base64url'),type:'spki',format:'der'}),Buffer.from(body.signature,'base64url'))).toBe(true);
   expect(JSON.stringify(body)).not.toContain('accessToken');expect(JSON.stringify(body)).not.toContain('refreshToken');
   return json({version:1,sessionId:'00000000-0000-4000-8000-000000000001'});
  }
  if(url.pathname==='/api/chatgpt-plan/device/poll'){
   polls++;
   await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new DOMException('cancelled','AbortError'));};const timer=setTimeout(()=>{init?.signal?.removeEventListener('abort',abort);resolve();},15);init?.signal?.addEventListener('abort',abort,{once:true});});
   const requests=queued;queued=[];return json({version:1,requests});
  }
  if(url.pathname==='/api/chatgpt-plan/device/reply'){replies.push(JSON.parse(String(init?.body)));return json({ok:true});}
  if(url.pathname==='/api/chatgpt-plan/device/disconnect')return json({ok:true});
  throw new Error('unexpected fixture endpoint');
 });
 const service=createNativeChatgptPlanService({vault,auth:{getStatus:()=>authState,getToken:()=> 'fixture-matrix-bearer',getGatewayOrigin:()=> 'https://matrix.test'},openBrowser:async url=>{browserOpens++;authUrl=new URL(url);},fetchFn});
 async function finish(){const callback=new URL(authUrl!.searchParams.get('redirect_uri')!);callback.searchParams.set('state',authUrl!.searchParams.get('state')!);callback.searchParams.set('code','fixture-code');callback.searchParams.set('client_id','oaiapp_matrix_fixture');expect((await fetch(callback)).status).toBe(200);}
 async function signedIn(){await service.connect({...localSession,purpose:'personal_local'});await finish();await vi.waitFor(async()=>expect((await service.status(localSession)).bridgeConnected).toBe(true));}
 return {service,vault,authState,snapshots,replies,providerBodies,fetchFn,finish,signedIn,queue:(items:ChatGptPlanPeerRequest[])=>{queued.push(...items);},changeModel:(model:string)=>{visibleModel=model;},holdCatalog:()=>{catalogGate=new Promise(resolve=>{releaseCatalog=()=>{catalogGate=null;resolve();};});return ()=>releaseCatalog();},holdRefresh:()=>{refreshGate=new Promise(resolve=>{releaseRefresh=()=>{refreshGate=null;resolve();};});return ()=>releaseRefresh();},lateFailure:()=>{lateFailure=true;},rejectNonce:()=>{rejectNonce=true;},expireSoon:()=>{expiresIn=1;},holdJwks:()=>{jwksHeld=false;jwksGate=new Promise(resolve=>{releaseJwks=()=>{jwksGate=null;resolve();};});return ()=>releaseJwks();},rejectCatalog:()=>{rejectCatalog=true;},get browserOpens(){return browserOpens;},get jwksHeld(){return jwksHeld;},get refreshes(){return refreshes;},get polls(){return polls;},get revoked(){return revoked;},cleanup:async()=>{await service.dispose();await rm(dir,{recursive:true,force:true});}};
}
function request(id:string,accountId:string,grantRevision:number):ChatGptPlanPeerRequest {
 const sequence=Number.parseInt(id.slice(-12),16);
 return {version:1,action:'infer',id:chatGptPlanPeerRequestId('00000000-0000-4000-8000-000000000001',sequence),sequence,expiresAt:new Date(Date.now()+120000).toISOString(),accountId,grantRevision,computerId:'computer',runId:'run_fixture',requestClass:'interactive',model:'fixture-visible',body:JSON.stringify({model:'fixture-visible',input:[{role:'user',content:'fixture only'}],store:false,stream:true})};
}
describe('native subscription authorization to signed peer transport (explicit mocked issuer)',()=>{
 it('pins nonprimary native bridge traffic to the selected Computer runtime',async()=>{
  const x=await fixture('preview');try{
   await x.signedIn();const status=await x.service.setGrant({runtimeSlot:'preview',authGeneration:1,enabled:true,background:false});
   x.queue([request('00000000-0000-4000-8000-000000000009',status.account!.id,status.grant.revision)]);
   await vi.waitFor(()=>expect(x.replies).toHaveLength(1));expect(x.replies[0]?.ok).toBe(true);
  }finally{await x.cleanup();}
 });
 it('connect authorizes interactive Bots and completes local OAuth-only inference by default',async()=>{
  const x=await fixture();try{
   await x.signedIn();const status=await x.service.status(session);expect(status.grant).toMatchObject({enabled:true,background:false});expect(status.models.map(x=>x.id)).toEqual(['fixture-visible']);
   expect(status.bridgeConnected).toBe(true);
   x.queue([request('00000000-0000-4000-8000-000000000002',status.account!.id,status.grant.revision)]);
   await vi.waitFor(()=>expect(x.replies).toHaveLength(1));expect(x.replies[0]?.ok).toBe(true);expect(x.providerBodies).toHaveLength(1);expect(x.providerBodies[0]).toMatchObject({store:false,stream:true});
   expect(x.snapshots[0]).toMatchObject({enabled:true,background:false});
  }finally{await x.cleanup();}
 });
 it('reuses only the active account on explicit reconnect, leaving reads and other Computer grants unchanged',async()=>{
  const x=await fixture();try{
   await x.signedIn();const before=await x.service.setGrant({...session,enabled:false,background:false});
   let stored=await x.vault.load('owner');stored.grants.push({computerId:'other-computer',revision:7,enabled:false,background:false});await x.vault.save('owner',stored);
   // Reload the persisted account/grants under the same owner and Computer.
   x.authState.authGeneration=2;x.service.cancelAll();const next={...session,authGeneration:2};
   expect((await x.service.status(next)).grant.enabled).toBe(false);
   await x.service.refreshModels(next);expect((await x.service.status(next)).grant.enabled).toBe(false);
   const browserCount=x.browserOpens;
   const after=await x.service.connect({...next,purpose:'personal_local'});
   expect(after).toMatchObject({state:'connected',account:{id:before.account!.id},grant:{enabled:true,background:false,revision:before.grant.revision+1},bridgeConnected:true});
   expect(x.browserOpens).toBe(browserCount);
   stored=await x.vault.load('owner');expect(stored.grants.find(g=>g.computerId==='other-computer')).toEqual({computerId:'other-computer',revision:7,enabled:false,background:false});
   x.queue([request('00000000-0000-4000-8000-000000000010',after.account!.id,before.grant.revision)]);
   await vi.waitFor(()=>expect(x.replies).toHaveLength(1));expect(x.replies[0]?.ok).toBe(false);expect(x.providerBodies).toHaveLength(0);
  }finally{await x.cleanup();}
 });
 it('keeps the old disabled grant when explicit reconnect cannot verify the catalog',async()=>{
  const x=await fixture();try{
   await x.signedIn();const before=await x.service.setGrant({...session,enabled:false,background:false});x.rejectCatalog();
   await expect(x.service.connect({...session,purpose:'personal_local'})).rejects.toThrow('network_error');
   const stored=await x.vault.load('owner');expect(stored.activeAccountId).toBe(before.account!.id);
   expect(stored.grants.find(g=>g.computerId==='computer')).toMatchObject({revision:before.grant.revision,enabled:false,background:false});
   expect(x.providerBodies).toHaveLength(0);
  }finally{await x.cleanup();}
 });
 it('fences reconnect catalog completion after owner or Computer changes',async()=>{
  const x=await fixture();let release=()=>{};try{
   await x.signedIn();await x.service.setGrant({...session,enabled:false,background:false});release=x.holdCatalog();
   const reconnect=x.service.connect({...session,purpose:'personal_local'});const rejected=expect(reconnect).rejects.toThrow();
   await vi.waitFor(()=>expect(x.fetchFn.mock.calls.filter(call=>String(call[0]).endsWith('/v1/models')).length).toBeGreaterThan(1));
   x.authState.handle='other-computer';x.authState.authGeneration=2;x.service.cancelAll();release();await rejected;
   expect((await x.vault.load('owner')).grants.find(g=>g.computerId==='computer')?.enabled).toBe(false);
  }finally{release();await x.cleanup();}
 });
 it('cancellation fences a late reconnect without enabling a deliberately disabled grant',async()=>{
  const x=await fixture();let release=()=>{};try{
   await x.signedIn();const before=await x.service.setGrant({...session,enabled:false,background:false});release=x.holdCatalog();
   const reconnect=x.service.connect({...session,purpose:'personal_local'});const rejected=expect(reconnect).rejects.toThrow();
   await vi.waitFor(()=>expect(x.fetchFn.mock.calls.filter(call=>String(call[0]).endsWith('/v1/models')).length).toBeGreaterThan(1));
   await x.service.cancel(session);release();await rejected;
   const stored=await x.vault.load('owner');expect(stored.accounts[0]?.tokens).not.toBeNull();
   expect(stored.grants.find(g=>g.computerId==='computer')).toMatchObject({revision:before.grant.revision,enabled:false,background:false});
   expect((await x.service.status(session)).grant.enabled).toBe(false);expect(x.providerBodies).toHaveLength(0);
  }finally{release();await x.cleanup();}
 });
 it('explicit disconnect wins over a late reconnect and subsequent status reads',async()=>{
  const x=await fixture();let release=()=>{};try{
   await x.signedIn();await x.service.setGrant({...session,enabled:false,background:false});release=x.holdCatalog();
   const reconnect=x.service.connect({...session,purpose:'personal_local'});const rejected=expect(reconnect).rejects.toThrow();
   await vi.waitFor(()=>expect(x.fetchFn.mock.calls.filter(call=>String(call[0]).endsWith('/v1/models')).length).toBeGreaterThan(1));
   expect(await x.service.disconnect(session)).toMatchObject({state:'disconnected',grant:{enabled:false,background:false},bridgeConnected:false});
   release();await rejected;const stored=await x.vault.load('owner');expect(stored.accounts[0]?.tokens).toBeNull();
   expect(stored.grants.every(g=>!g.enabled&&!g.background)).toBe(true);
   expect(await x.service.status(session)).toMatchObject({state:'disconnected',grant:{enabled:false},models:[],bridgeConnected:false});
   expect(x.providerBodies).toHaveLength(0);
  }finally{release();await x.cleanup();}
 });
 it('rejects background, account replacement and Stop without fallback or poisoning next interactive run',async()=>{
  const x=await fixture();try{
   await x.signedIn();const status=await x.service.setGrant({...session,enabled:true,background:false});
   const blocked=request('00000000-0000-4000-8000-000000000002',status.account!.id,status.grant.revision);blocked.requestClass='background';
   x.queue([blocked]);await vi.waitFor(()=>expect(x.replies).toHaveLength(1));expect(x.replies[0]?.ok).toBe(false);expect(x.providerBodies).toHaveLength(0);
   const stopped=request('00000000-0000-4000-8000-000000000003',status.account!.id,status.grant.revision);
   x.queue([stopped,{version:1,action:'cancel',id:stopped.id}]);await vi.waitFor(()=>expect(x.polls).toBeGreaterThan(3));
   expect((await x.service.status(session)).bridgeConnected).toBe(true);
   x.queue([request('00000000-0000-4000-8000-000000000004',status.account!.id,status.grant.revision)]);await vi.waitFor(()=>expect(x.replies).toHaveLength(2));expect(x.replies[1]?.ok).toBe(true);expect(x.providerBodies).toHaveLength(1);
  }finally{await x.cleanup();}
 });
 it('serializes rotating refresh before concurrent model readers and persists the replacement together',async()=>{
  const x=await fixture();try{
   x.expireSoon();await x.service.connect({...session,purpose:'personal_local'});await x.finish();
   await vi.waitFor(async()=>expect((await x.service.status(session)).bridgeConnected).toBe(true));
   await Promise.all([x.service.refreshModels(session),x.service.status(session),x.service.status(session)]);
   expect(x.refreshes).toBe(1);const stored=(await x.vault.load('owner')).accounts[0]!.tokens!;
   expect(stored.expiresAt).toBeGreaterThan(Date.now()+60000);expect(stored.refreshToken).toBe('fixture-refresh');
  }finally{await x.cleanup();}
 });
 it('publishes changed catalogs but retains an unchanged connected peer and rejects removed models',async()=>{
  const x=await fixture();try{
   await x.signedIn();const status=await x.service.setGrant({...session,enabled:true,background:false});const count=x.snapshots.length;
   await Promise.all([x.service.refreshModels(session),x.service.refreshModels(session)]);expect(x.snapshots).toHaveLength(count);
   x.changeModel('fixture-new');await x.service.refreshModels(session);expect(x.snapshots).toHaveLength(count+1);
   expect((x.snapshots.at(-1) as {models:Array<{id:string}>}).models[0]?.id).toBe('fixture-new');
   x.queue([request('00000000-0000-4000-8000-000000000009',status.account!.id,status.grant.revision)]);
   await vi.waitFor(()=>expect(x.replies).toHaveLength(1));expect(x.replies[0]?.ok).toBe(false);expect(x.providerBodies).toHaveLength(0);
  }finally{await x.cleanup();}
 });
 it('a stale old-owner catalog failure cannot overwrite the new owner status',async()=>{
  const x=await fixture();let dateSpy:ReturnType<typeof vi.spyOn>|undefined;try{
   await x.signedIn();const release=x.holdCatalog();const now=Date.now();dateSpy=vi.spyOn(Date,'now').mockReturnValue(now+6*60000);
   const previous=x.service.status(session);const rejected=expect(previous).rejects.toThrow();
   await vi.waitFor(()=>expect(x.fetchFn.mock.calls.filter(call=>String(call[0]).endsWith('/v1/models')).length).toBeGreaterThan(1));
   x.authState.userId='other-owner';x.authState.authGeneration=2;x.service.cancelAll();dateSpy.mockRestore();dateSpy=undefined;
   const nextSession={...session,authGeneration:2};expect((await x.service.status(nextSession)).state).toBe('disconnected');
   release();await rejected;expect((await x.service.status(nextSession)).state).toBe('disconnected');
  }finally{dateSpy?.mockRestore();await x.cleanup();}
 });
 it('a cancelled late authorization cannot disconnect the replacement runtime peer',async()=>{
  const x=await fixture();let release:()=>void=()=>{};
  try{
   await x.signedIn();await x.service.setGrant({...session,enabled:true,background:false});
   release=x.holdJwks();await x.service.connect({...session,purpose:'personal_local'});await x.finish();
   await vi.waitFor(()=>expect(x.jwksHeld).toBe(true));
   x.authState.authGeneration=2;x.service.cancelAll();
   const replacement={...session,authGeneration:2};
   expect((await x.service.status(replacement)).bridgeConnected).toBe(true);
   const before=x.snapshots.length;release();
   await new Promise(resolve=>setTimeout(resolve,50));
   expect((await x.service.status(replacement)).bridgeConnected).toBe(true);
   expect(x.snapshots).toHaveLength(before);
  }finally{release();await x.cleanup();}
 });
 it('grant revocation racing rotating refresh drains without mutation-lock deadlock',async()=>{
  const x=await fixture();let dateSpy:ReturnType<typeof vi.spyOn>|undefined;let release=()=>{};try{
   await x.signedIn();const status=await x.service.setGrant({...session,enabled:true,background:false});release=x.holdRefresh();
   const now=Date.now();dateSpy=vi.spyOn(Date,'now').mockReturnValue(now+4*60000+1000);
   x.queue([request('00000000-0000-4000-8000-000000000008',status.account!.id,status.grant.revision)]);
   await vi.waitFor(()=>expect(x.refreshes).toBe(1));const revoked=x.service.setGrant({...session,enabled:false,background:false});
   release();dateSpy.mockRestore();dateSpy=undefined;
   await expect(Promise.race([revoked,new Promise((_,reject)=>setTimeout(()=>reject(new Error('deadlock')),1000))])).resolves.toMatchObject({grant:{enabled:false}});
   expect(x.providerBodies).toHaveLength(0);
  }finally{release();dateSpy?.mockRestore();await x.cleanup();}
 });
 it('late provider failure discards partial output and cannot masquerade as a completed reply',async()=>{
  const x=await fixture();try{await x.signedIn();const status=await x.service.setGrant({...session,enabled:true,background:false});x.lateFailure();x.queue([request('00000000-0000-4000-8000-000000000007',status.account!.id,status.grant.revision)]);await vi.waitFor(()=>expect(x.replies).toHaveLength(1));expect(x.replies[0]?.ok).toBe(false);expect(x.replies[0]).not.toHaveProperty('body');}finally{await x.cleanup();}
 });
 it('keeps validated active account on failed reauthorization and revokes/clears tokens on sign out',async()=>{
  const x=await fixture();try{
   await x.signedIn();const before=await x.service.status(session);x.rejectNonce();await x.service.connect({...session,purpose:'personal_local'});await x.finish();
   await vi.waitFor(async()=>expect((await x.service.status(session)).state).toBe('connected'));
   expect((await x.service.status(session)).account?.id).toBe(before.account?.id);
   const out=await x.service.disconnect(session);expect(out.state).toBe('disconnected');expect(out.revocation).toBe('confirmed');expect(x.revoked).toBe(true);expect((await x.vault.load('owner')).accounts[0]?.tokens).toBeNull();
  }finally{await x.cleanup();}
 });
});
