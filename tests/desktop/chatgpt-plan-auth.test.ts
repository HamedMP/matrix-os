import { generateKeyPairSync } from 'node:crypto';
import { exportJWK, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { validatePlanTokens, planAuthorizationUrl, parsePlanCallback } from '../../desktop/src/main/chatgpt-plan/oauth';
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
