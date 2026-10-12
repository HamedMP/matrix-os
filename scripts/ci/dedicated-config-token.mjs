// The Actions token cannot read repository Variables. Keep this credential
// separate from both Actions writes and the checks-only protected gate issuer.
import {sign} from 'node:crypto';
const request={timeout:10_000};
const id=value=>Number.isSafeInteger(value)&&value>0;
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
async function mintConfigurationCredential(github,repo,options){
 const {appId,installationId,repositoryId,privateKey,mask}=options;
 if(![appId,installationId,repositoryId].every(id)||typeof privateKey!=='string'||!privateKey||privateKey.length>16_384||typeof mask!=='function')throw new Error('Invalid configuration read token settings');
 let token;
 try{
  const now=Math.floor(Date.now()/1000);
  const unsigned=`${encode({alg:'RS256',typ:'JWT'})}.${encode({iat:now-60,exp:now+540,iss:String(appId)})}`;
  const jwt=`${unsigned}.${sign('RSA-SHA256',Buffer.from(unsigned),privateKey).toString('base64url')}`;
  mask(jwt);
  const app=new github.constructor({auth:jwt,baseUrl:github.request.endpoint.DEFAULTS.baseUrl,request});
  const {data:identity}=await app.request('GET /app',{request});
  if(identity.id!==appId)throw new Error('Unexpected configuration App identity');
  // This permission is not exposed by the pinned create-github-app-token action.
  const {data}=await app.request('POST /app/installations/{installation_id}/access_tokens',{
   installation_id:installationId,repository_ids:[repositoryId],permissions:{actions_variables:'read'},request});
  token=data.token;
  if(typeof token!=='string'||!token||token.length>8192)throw new Error('Invalid configuration token');
  mask(token);
  const permissions=data.permissions??{},repositories=data.repositories,expiry=Date.parse(data.expires_at);
  if(permissions.actions_variables!=='read'||Object.entries(permissions).some(([name,value])=>!['actions_variables','metadata'].includes(name)||value!=='read')||
     !Array.isArray(repositories)||repositories.length!==1||repositories[0].id!==repositoryId||repositories[0].full_name?.toLowerCase()!==`${repo.owner}/${repo.repo}`.toLowerCase()||
     !Number.isFinite(expiry)||expiry<Date.now()+60_000||expiry>Date.now()+65*60_000)throw new Error('Unexpected configuration token scope');
  return {token,expiresAt:expiry};
 }catch{
  // Octokit errors include request headers. Never propagate App JWT/token data.
  if(typeof token==='string'&&token){
   mask(token);
   try{const client=new github.constructor({auth:token,baseUrl:github.request.endpoint.DEFAULTS.baseUrl,request});await client.request('DELETE /installation/token',{request});}
   catch{throw new Error('Configuration read token validation and revocation failed');}
  }
  throw new Error('Configuration read token could not be authenticated');
 }
}
export function withConfigurationGithub(github,configurationGithub){
 if(configurationGithub===github||typeof configurationGithub?.rest?.actions?.listRepoVariables!=='function')throw new Error('Separate configuration read client is required');
 return {...github,rest:{...github.rest,actions:{...github.rest.actions,listRepoVariables:configurationGithub.rest.actions.listRepoVariables.bind(configurationGithub.rest.actions)}}};
}

export async function mintConfigurationToken(github,repo,options){return(await mintConfigurationCredential(github,repo,options)).token;}
async function revoke(github,token){
 try{const client=new github.constructor({auth:token,baseUrl:github.request.endpoint.DEFAULTS.baseUrl,request});await client.request('DELETE /installation/token',{request});}
 catch{throw new Error('Configuration read token revocation failed');}
}
// Renewal owns at most two credentials during the swap. No old read fallback.
export function createConfigurationSession(github,repo,options){
 let current,pending,closed=false;
 async function fresh(){
  if(closed)throw new Error('Configuration session is closed');
  if(current&&current.expiresAt>Date.now()+5*60_000)return current.client;
  if(!pending)pending=(async()=>{
   const next=await mintConfigurationCredential(github,repo,options);
   const client=new github.constructor({auth:next.token,baseUrl:github.request.endpoint.DEFAULTS.baseUrl,request});
   if(current){try{await revoke(github,current.token);}catch(error){await revoke(github,next.token);throw error;}}
   current={...next,client};return client;
  })();
  try{return await pending;}finally{pending=undefined;}
 }
 const configurationGithub={rest:{actions:{listRepoVariables:async args=>(await fresh()).rest.actions.listRepoVariables(args)}}};
 return {github:withConfigurationGithub(github,configurationGithub),close:async()=>{
  closed=true;
  try{if(pending)await pending;}finally{if(current){const token=current.token;current=undefined;await revoke(github,token);}}
 }};
}
