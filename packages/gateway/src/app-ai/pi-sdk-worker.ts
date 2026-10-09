/** Fixed public SDK inference worker. No agent session, owner extensions, hooks,
 * context files or tool runtime is loaded. OAuth refresh remains in the owner's
 * locked native file; cancellation drains refresh persistence before exit. */
export const PI_APP_SDK_WORKER = String.raw`
import { lstat,open,readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname,join } from 'node:path';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
const stop=new AbortController();
function warnFailure(stage,error){
 const safeNames=['Error','TypeError','SyntaxError','RangeError','AbortError','TimeoutError','ZodError'];
 const name=error instanceof Error&&safeNames.includes(error.name)?error.name:'UnknownError';
 console.warn('[app-ai] Pi '+stage+' failed',name);
}
const maxPendingCredentialUpdates=16;
// Reject before starting a lock or mutation; admitted updates stay tracked until
// settlement, including during cancellation and the nonced drain receipt.
const pending=new Set();
let credentialMutationFailed=false;
let configuration;
let authorize;
let inputReceived=false;
let stdinBytes=0;
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const started=new Promise((resolve,reject)=>{
 lines.on('line',line=>{
  stdinBytes+=Buffer.byteLength(line);
  if(stdinBytes>131072){reject(Error('input'));stop.abort();return;}
  try{
   const value=JSON.parse(line);
   if(!inputReceived){inputReceived=true;configuration=value;resolve(value);}
   else if(value.type==='authorized'&&authorize){const settle=authorize;authorize=undefined;settle(value.allowed===true);}
   else{stop.abort();reject(Error('input'));}
  }catch(error){warnFailure('worker input',error);stop.abort();reject(Error('input'));}
 });
 lines.on('close',()=>{if(!inputReceived)reject(Error('input'));});
});
process.on('SIGTERM',()=>{stop.abort();if(authorize){authorize(false);authorize=undefined;}});
const maxBytes=256000;
const allowedHosts=new Set(['api.openai.com','chatgpt.com','auth.openai.com','api.anthropic.com','console.anthropic.com','platform.claude.com','claude.ai','openrouter.ai','api.groq.com','api.cerebras.ai','api.deepseek.com','api.x.ai','api.z.ai','api.mistral.ai','api.together.xyz','api.fireworks.ai','api.baseten.co']);
function endpoint(value){const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||!allowedHosts.has(url.hostname))throw Error('endpoint');return url;}
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
 const request=input instanceof Request?input:undefined;
 endpoint(request?.url??String(input));
 const signal=AbortSignal.any([init?.signal??request?.signal??AbortSignal.timeout(15000),AbortSignal.timeout(30000)]);
 const response=await originalFetch(input,{...init,redirect:'error',signal});
 if(!response.body)return response;
 const reader=response.body.getReader();let size=0;
 const abort=()=>{void reader.cancel().catch(error=>warnFailure('response cancellation',error));};
 signal.addEventListener('abort',abort,{once:true});
 const body=new ReadableStream({
  async pull(controller){try{signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done){signal.removeEventListener('abort',abort);reader.releaseLock();controller.close();return;}size+=next.value.byteLength;if(size>maxBytes)throw Error('response');controller.enqueue(next.value);}catch(error){await reader.cancel().catch(error=>warnFailure('response cancellation',error));signal.removeEventListener('abort',abort);controller.error(error);}},
  async cancel(){signal.removeEventListener('abort',abort);await reader.cancel();}
 });
 return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
};
async function assertAuthFile(path){
 for(const directory of [dirname(dirname(path)),dirname(path)]){const metadata=await lstat(directory);if(!metadata.isDirectory()||metadata.isSymbolicLink())throw Error('profile');}
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const metadata=await file.stat();if(!metadata.isFile()||metadata.size>maxBytes)throw Error('profile');const buffer=Buffer.alloc(maxBytes+1);const {bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>maxBytes)throw Error('profile');return JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));}finally{await file.close();}
}
function credential(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('credential');
 if(value.type==='api_key'){
  if(typeof value.key!=='string'||!value.key||value.key.length>8192||value.key.startsWith('!')||value.key.includes('$')||value.env&&Object.keys(value.env).length)throw Error('credential');
  return {type:'api_key',key:value.key};
 }
 if(value.type==='oauth'&&typeof value.refresh==='string'&&value.refresh&&typeof value.access==='string'&&value.access&&Number.isFinite(value.expires))return value;
 throw Error('credential');
}
function identity(value){
 if(value.type==='api_key')return createHash('sha256').update(value.key).digest('hex');
 const stable={};for(const [key,item]of Object.entries(value))if(!['access','refresh','expires','type'].includes(key))stable[key]=item;
 // Account claims are stable across token rotation, unlike the token bytes.
 for(const token of [value.access,value.id_token]){if(typeof token!=='string'||!token.includes('.'))continue;try{const claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));for(const key of ['sub','email','https://api.openai.com/auth'])if(claims[key]!==undefined)stable[key]=claims[key];}catch(error){warnFailure('account claims',error);}}
 return createHash('sha256').update(JSON.stringify(Object.keys(stable).length?stable:value)).digest('hex');
}
try{
 const supplied=await started;
 if(!['probe','generate'].includes(supplied.mode)||typeof supplied.providerId!=='string'||typeof supplied.modelId!=='string'||typeof supplied.authPath!=='string'||typeof supplied.prompt!=='string'||supplied.prompt.length>32768||typeof supplied.drainToken!=='string'||!/^[0-9a-f-]{36}$/.test(supplied.drainToken))throw Error('input');
 const sdk=await import(process.argv[1]);
 const authSdk=await import(process.argv[2]);
 if(typeof sdk.ModelRuntime?.create!=='function'||typeof authSdk.FileAuthStorageBackend!=='function')throw Error('unsupported');
 const initial=credential((await assertAuthFile(supplied.authPath))[supplied.providerId]);
 let expected=identity(initial);
 const backend=new authSdk.FileAuthStorageBackend(supplied.authPath);
 async function locked(fn,options){
  await assertAuthFile(supplied.authPath);
  return backend.withLockAsync(async()=>{
   const data=await assertAuthFile(supplied.authPath);
   const current=credential(data[supplied.providerId]);
   if(identity(current)!==expected)throw Error('account changed');
   return fn(data,current);
  },options);
 }
 const credentials={
  read:async(provider,options)=>provider!==supplied.providerId?undefined:locked(async(_data,current)=>({result:current}),options),
  list:async()=>[{providerId:supplied.providerId,type:initial.type}],
  modify:(provider,fn,options)=>{
   if(provider!==supplied.providerId)throw Error('provider');
   if(pending.size>=maxPendingCredentialUpdates)throw Error('credential update limit');
   const task=locked(async(data,current)=>{const next=await fn(current);if(next===undefined)return {result:current};const validated=credential(next);expected=identity(validated);return {result:validated,next:JSON.stringify({...data,[provider]:validated},null,2)};},options);
   pending.add(task);void task.then(()=>pending.delete(task),error=>{credentialMutationFailed=true;warnFailure('credential update',error);pending.delete(task);});return task;
  },
  delete:async()=>{throw Error('read only');}
 };
 const runtime=await sdk.ModelRuntime.create({credentials,modelsPath:supplied.modelsPath??null,refreshOnCreate:false,allowModelNetwork:false,signal:stop.signal});
 if(runtime.getError?.())throw Error('configuration');
 function selectedModel(id){const model=runtime.getPhysicalModel(supplied.providerId,id);if(!model||model.provider!==supplied.providerId||model.id!==id||!['openai-completions','openai-responses','openai-codex-responses','anthropic-messages','mistral-conversations'].includes(model.api))throw Error('model');endpoint(model.baseUrl);return model;}
 if(supplied.mode==='probe'){
  const ids=supplied.modelIds??[supplied.modelId];if(!Array.isArray(ids)||ids.length>256||ids.some(id=>typeof id!=='string'||id.length>512))throw Error('input');
  const supported=[];for(const id of ids){try{selectedModel(id);supported.push(id);}catch(error){warnFailure('model readiness',error);}}
  send({type:'supported',models:supported});
 }
 else{
  const model=selectedModel(supplied.modelId);
  const auth=await runtime.getAuth(model,{signal:stop.signal,env:{}});
  if(!auth)throw Error('credential');
  if(auth.auth.baseUrl)endpoint(auth.auth.baseUrl);
  stop.signal.throwIfAborted();
  const allowed=new Promise(resolve=>{authorize=resolve;});send({type:'authorize'});
  if(!await allowed)throw Error('revoked');
  stop.signal.throwIfAborted();
  const completion=runtime.completeSimple(model,{systemPrompt:'Answer using only the supplied text. You have no tools or access to files.',messages:[{role:'user',content:supplied.prompt,timestamp:Date.now()}],tools:[]},{signal:stop.signal,toolChoice:'none',transport:'sse',maxTokens:Math.min(model.maxTokens??8192,8192),maxRetries:0,timeoutMs:30000,env:{},fetch:globalThis.fetch,onPayload:payload=>{
   if(!payload||typeof payload!=='object'||payload.model!==model.id||['tools','functions','additional_tools'].some(key=>payload[key]!==undefined&&(!Array.isArray(payload[key])||payload[key].length!==0))||payload.tool_choice&&payload.tool_choice!=='none'&&!(typeof payload.tool_choice==='object'&&!Array.isArray(payload.tool_choice)&&payload.tool_choice.type==='none'&&Object.keys(payload.tool_choice).length===1))throw Error('tools');
  }});
  const abort=new Promise((_,reject)=>{if(stop.signal.aborted)reject(Error('cancelled'));else stop.signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});});
  const result=await Promise.race([completion,abort]);
  stop.signal.throwIfAborted();
  if(result.role!=='assistant'||result.provider!==model.provider||result.model!==model.id||result.stopReason!=='stop'||!Array.isArray(result.content)||result.content.some(part=>!['text','thinking'].includes(part.type)))throw Error('completion');
  const text=result.content.filter(part=>part.type==='text').map(part=>part.text).join('');
  if(typeof text!=='string'||!text||text.length>64000||Buffer.byteLength(text)>maxBytes)throw Error('completion');
  // A concurrent native logout/account replacement invalidates the result.
  await credentials.read(supplied.providerId,{signal:stop.signal});
  send({type:'result',text});
 }
 await Promise.allSettled([...pending]);
 if(!credentialMutationFailed)send({type:'drained',token:supplied.drainToken});lines.close();process.stdout.write('',()=>process.exit(0));
}catch(error){
 warnFailure('worker completion',error);stop.abort();await Promise.allSettled([...pending]);
 // Provider exceptions may contain keys/tokens. Emit only a fixed failure.
 send({type:'failed'});if(!credentialMutationFailed&&typeof configuration?.drainToken==='string')send({type:'drained',token:configuration.drainToken});lines.close();process.stdout.write('',()=>process.exit(1));
}
`;
