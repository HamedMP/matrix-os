import { generateKeyPairSync } from 'node:crypto';
import { exportJWK, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { validatePlanTokens, planAuthorizationUrl, parsePlanCallback, planJson } from '../../desktop/src/main/chatgpt-plan/oauth';
const pair=generateKeyPairSync('rsa',{modulusLength:2048});
const scope='openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
async function fixture(overrides:Record<string,unknown>={}) {
 const jwk={...await exportJWK(pair.publicKey),kid:'test',alg:'RS256'};
 const id=await new SignJWT({nonce:'nonce',email:'owner@example.test',...overrides}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer('https://auth.openai.com').setAudience('oaiapp_test').setSubject('subject').setExpirationTime('5m').sign(pair.privateKey);
 const access=await new SignJWT({client_id:'oaiapp_test',scope}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer('https://auth.openai.com').setAudience('https://api.openai.com/v1').setSubject('subject').setExpirationTime('5m').sign(pair.privateKey);
 return {jwks:{keys:[jwk]},raw:{id_token:id,access_token:access,refresh_token:'refresh-private',scope,expires_in:300,token_type:'Bearer'}};
}
describe('own Matrix ChatGPT OAuth identity boundary',()=>{
 it('uses Matrix identity and exact loopback PKCE callback, never borrowed OAuth client',()=>{
  const url=new URL(planAuthorizationUrl({hostId:'urn:uuid:host',redirectUri:'http://127.0.0.1:1455/auth/callback',state:'state',nonce:'nonce',verifier:'secret'}));
  expect(url.origin).toBe('https://auth.openai.com');expect(url.searchParams.get('agent_name_hint')).toBe('Matrix OS');expect(url.searchParams.get('client_id')).toBe('dynamic_agent_client');expect(url.searchParams.get('code_challenge_method')).toBe('S256');expect(url.searchParams.has('code_verifier')).toBe(false);
 });
 it('rejects wrong state, duplicate params, wrong issued client and dynamic exchange ID',()=>{
  const pending={state:'secret',clientId:'oaiapp_test'};
  expect(()=>parsePlanCallback('/auth/callback?state=other&code=code',pending)).toThrow();
  expect(()=>parsePlanCallback('/auth/callback?state=secret&state=secret&code=code',pending)).toThrow();
  expect(()=>parsePlanCallback('/auth/callback?state=secret&code=code&client_id=oaiapp_other',pending)).toThrow();
  expect(()=>parsePlanCallback('/auth/callback?state=secret&code=code&client_id=dynamic_agent_client',{state:'secret'})).toThrow();
 });
 it('checks signed nonce, grant, resource audience and returning account before persistence',async()=>{
  const x=await fixture();expect((await validatePlanTokens(x.raw,{jwks:x.jwks,clientId:'oaiapp_test',nonce:'nonce'})).subject).toBe('subject');
  await expect(validatePlanTokens({...x.raw,scope:'openid email'},{jwks:x.jwks,clientId:'oaiapp_test',nonce:'nonce'})).rejects.toThrow();
  await expect(validatePlanTokens(x.raw,{jwks:x.jwks,clientId:'oaiapp_test',nonce:'wrong'})).rejects.toThrow();
  await expect(validatePlanTokens(x.raw,{jwks:x.jwks,clientId:'oaiapp_other',nonce:'nonce'})).rejects.toThrow();
  await expect(validatePlanTokens(x.raw,{jwks:x.jwks,clientId:'oaiapp_test',nonce:'nonce',subject:'foreign'})).rejects.toThrow();
  const forged=await fixture({nonce:'bad'});await expect(validatePlanTokens(forged.raw,{jwks:x.jwks,clientId:'oaiapp_test',nonce:'nonce'})).rejects.toThrow();
 });
 it('rejects unsigned/malformed tokens and rotated subject',async()=>{
  const x=await fixture();await expect(validatePlanTokens({...x.raw,access_token:'opaque-key'},{jwks:x.jwks,clientId:'oaiapp_test',nonce:'nonce'})).rejects.toThrow();
 });
});


it.each([
 [400,{error:'invalid_grant',error_description:'private provider text'},'credential_rejected'],
 [400,{error:'invalid_client'},'http_error'],
 [400,{error:'unknown'},'http_error'],
 [429,{error:'invalid_grant'},'http_error'],
])('OAuth status%s classifies only definitive standard refresh rejection',async(status,body,category)=>{
 const fetchFn=vi.fn(async()=>Response.json(body,{status}));
 const failure=await planJson(fetchFn,'token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token'})}).catch(error=>error);
 expect(failure).toMatchObject({stage:'oauth_token',httpStatus:status,category});expect(JSON.stringify(failure)).not.toContain('private provider text');
});


it('bounds malformed, oversize, cancelled and stalled OAuth error bodies without leaking text',async()=>{
 const read=(response:Response,signal?:AbortSignal)=>planJson(vi.fn(async()=>response),'token',{method:'POST',body:new URLSearchParams({grant_type:'refresh_token'}),signal}).catch(error=>error);
 for(const body of ['{malformed private text',JSON.stringify({error:'invalid_grant',error_description:'private'.repeat(1000)})]){
  expect(await read(new Response(body,{status:400}))).toMatchObject({category:'http_error'});
 }
 const cancel=vi.fn();const controller=new AbortController();const stream=new ReadableStream({cancel});const pending=read(new Response(stream,{status:400}),controller.signal);await Promise.resolve();await Promise.resolve();controller.abort();expect(await pending).toMatchObject({category:'http_error'});expect(cancel).toHaveBeenCalledOnce();expect(stream.locked).toBe(false);
 vi.useFakeTimers();try{
  const stream=new ReadableStream({cancel});const pending=read(new Response(stream,{status:400}));await vi.advanceTimersByTimeAsync(1001);expect(await pending).toMatchObject({category:'http_error'});expect(stream.locked).toBe(false);
 }finally{vi.useRealTimers();}
});

it('does not classify authorization-code rejection as a saved refresh credential failure',async()=>{
 const failure=await planJson(vi.fn(async()=>Response.json({error:'invalid_grant'},{status:400})),'token',{method:'POST',body:new URLSearchParams({grant_type:'authorization_code'})}).catch(error=>error);
 expect(failure).toMatchObject({category:'http_error'});
});
