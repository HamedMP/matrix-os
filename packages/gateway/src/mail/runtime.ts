import type {Kysely} from 'kysely';
import {join} from 'node:path';
import {JEV_MODEL_ID,isMailConsumer,MailActionRequestSchema,type MailActionRequest} from '@matrix-os/contracts';
import {readLimited} from '../app-gallery/pinned-directory.js';
import {requireRequestPrincipal} from '../request-principal.js';
import type {PlatformDb} from '../platform-db.js';
import type {PipedreamConnectClient} from '../integrations/pipedream.js';
import type {JevService} from '../jev/service.js';
import type {FundedAiFundingSummaryReader} from '../funded-ai-funding-summary-client.js';
import type {FundedAiRouteReadinessReader} from '../funded-ai-route-readiness-client.js';
import {createFundedAiReadinessReader} from '../funded-ai-readiness.js';
import {MailArchiveRepository} from './repository.js';
import {MailObjectStore} from './objects.js';
import {createMailTransport} from './transport.js';
import {createObservedMailTransport} from './usage.js';
import {createMailGmailAdapter} from './gmail.js';
import {createMailService} from './service.js';
import {createMailWorker} from './worker.js';
import {createMailRoutes,MailRequestError} from './routes.js';
import {MailSyncSchedule} from './schedule.js';
import type {MailSource} from './types.js';
export function mailRuntimeOwner(principal:string,owners:readonly string[],ownerId:string){return owners.includes(principal)?ownerId:null;}
export async function hasInstalledMailConsumer(homePath:string,appId:string):Promise<boolean>{
 if(!isMailConsumer(appId))return false;
 try{const manifest=JSON.parse((await readLimited(join(homePath,'apps',appId,'matrix.json'),32768)).toString('utf8')) as {slug?:unknown;listingTrust?:unknown};return manifest.slug===appId&&manifest.listingTrust==='first_party';}
 catch(error){if(error instanceof Error&&'code'in error&&error.code==='ENOENT')return false;console.warn('[mail] Consumer unavailable',{errorName:error instanceof Error?error.name:'UnknownError'});return false;}
}
interface Options{homePath:string;ownerId:string;ownerIds:readonly string[];db:Kysely<unknown>;internalBaseUrl:string|null;machineToken?:string;platformDb?:PlatformDb|null;pipedream?:PipedreamConnectClient|null;jev:JevService|null;fundedOwnerId?:string;summary?:FundedAiFundingSummaryReader|null;routes?:FundedAiRouteReadinessReader;notify():void}
export async function createMailRuntime(o:Options){
 const repository=new MailArchiveRepository(o.db);await repository.bootstrap();const objects=new MailObjectStore(o.homePath);
 const transport=createObservedMailTransport({repository,transport:createMailTransport({internalBaseUrl:o.internalBaseUrl,machineToken:o.machineToken,db:o.platformDb,pipedream:o.pipedream})});
 const readiness=o.summary&&o.routes?createFundedAiReadinessReader({summary:o.summary,routes:o.routes,modelId:JEV_MODEL_ID}):null;
 const shutdown=new AbortController();let closed=false;let active:Promise<void>|null=null;let scheduled=false;const scheduleState=new MailSyncSchedule();
 const worker=createMailWorker({repository,objects,ownerId:o.ownerId,notify:o.notify,observeUsage:(source,event)=>repository.recordUsage({...source,events:[event]}),
  authorize:async (source,signal)=>{
   signal?.throwIfAborted();
   if(!await hasInstalledMailConsumer(o.homePath,'edition'))throw new MailRequestError(403);
   const granted=await repository.listGrantedSources({ownerId:o.ownerId,appId:'edition'});
   if(!granted.some(s=>s.accountId===source.accountId&&s.email===source.email&&s.connectionId===source.connectionId&&s.accountLabel===source.accountLabel&&!s.paused))throw new MailRequestError(403);
   const inventory=await transport.inventory(o.ownerId,signal);
   if(!inventory.some(c=>c.id===source.connectionId&&c.account_label===source.accountLabel&&c.account_email===source.email&&c.status==='active'))throw new MailRequestError(403);
  },
  jev:o.jev&&o.fundedOwnerId?{evaluate:(_owner,input,signal)=>o.jev!.evaluate(o.fundedOwnerId!,input,signal)}:null,
  fundedReady:async (_source,signal)=>{if(!readiness||!o.jev||!o.fundedOwnerId)return false;const result=await readiness.read({signal});return result.readiness.state==='ready'&&result.allowedModelIds.includes(JEV_MODEL_ID);},
  gmailForSource(source,signal){const binding={service:'gmail' as const,connectionId:source.connectionId,accountLabel:source.accountLabel,expectedEmail:source.email};return createMailGmailAdapter({signal,authorize:async()=>{
   const granted=await repository.listGrantedSources({ownerId:o.ownerId,appId:'edition'});if(!granted.some(s=>s.accountId===source.accountId&&s.email===source.email&&s.connectionId===source.connectionId&&!s.paused))throw new MailRequestError(403);
   const connections=await transport.inventory(o.ownerId,signal);if(!connections.some(c=>c.id===binding.connectionId&&c.account_email===binding.expectedEmail&&c.account_label===binding.accountLabel))throw new MailRequestError(403);
  },transport:(action,params,callSignal)=>transport.call(o.ownerId,binding,action,params,callSignal)});},
 });
 function report(error:unknown){console.warn('[mail] Background sync unavailable',{errorName:error instanceof Error?error.name:'UnknownError'});}
 async function tick(){if(closed||active)return;active=(async()=>{
  if(!await hasInstalledMailConsumer(o.homePath,'edition'))return;
  const sources=(await repository.listGrantedSources({ownerId:o.ownerId,appId:'edition'})).filter(source=>!source.paused).slice(0,100);
  const pending=[];for(const source of sources){const job=await repository.getSyncJob(source);if(!job)continue;const last=typeof job.checkpoint?.completedAt==='string'?Date.parse(job.checkpoint.completedAt):0;if(job.status==='completed'&&Date.now()-last<15*60_000)continue;pending.push({source,job});}
  for(let n=0;n<3&&!closed;n++){
   const id=scheduleState.pick(pending.map(item=>item.source.accountId),Date.now(),sources.map(source=>source.accountId));if(!id)break;
   const index=pending.findIndex(item=>item.source.accountId===id);const {source,job}=pending.splice(index,1)[0]!;
   try{if(job.status==='completed')await repository.enqueueSync({...source,rangeFrom:job.rangeFrom,rangeUntil:job.rangeUntil});await worker.sync(source,shutdown.signal);scheduleState.succeeded(id);}
   catch(error){scheduleState.failed(id,Date.now());report(error);}
  }
 })().catch(report).finally(()=>{active=null;});await active;}
 function schedule(source:MailSource){if(closed)return;scheduleState.request(source.accountId);if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;void tick();});}
 const service=createMailService({repository,objects,transport,ownerId:o.ownerId,sync:schedule,notify:o.notify});
 const routes=createMailRoutes({resolveOwner:c=>mailRuntimeOwner(requireRequestPrincipal(c,{isLocalDevelopment:false}).userId,o.ownerIds,o.ownerId),installed:appId=>hasInstalledMailConsumer(o.homePath,appId),handle:service.handle});
 const syncTimer=setInterval(()=>{void tick();},60_000);syncTimer.unref();
 let collecting:Promise<unknown>|null=null;
 const garbage=()=>{if(closed||collecting)return;collecting=objects.sweep({olderThan:new Date(Date.now()-60*60_000),maxCount:500,reclaim:(namespace,digest,remove)=>repository.collectObject(namespace,digest,remove)}).then(()=>repository.pruneExpiredObjectLeases({limit:500})).catch(report).finally(()=>{collecting=null;});};
 const cleanupTimer=setInterval(garbage,60*60_000);cleanupTimer.unref();queueMicrotask(()=>{void tick();garbage();});
 return{routes,async read(owner:string,input:MailActionRequest,signal:AbortSignal):Promise<unknown>{
   signal.throwIfAborted();const canonical=mailRuntimeOwner(owner,o.ownerIds,o.ownerId);
   if(!canonical||closed)throw new MailRequestError(403);
   const parsed=MailActionRequestSchema.safeParse(input);
   if(!parsed.success||!['sources','messages','message'].includes(parsed.data.action))throw new MailRequestError(400);
   if(!await hasInstalledMailConsumer(o.homePath,parsed.data.appId))throw new MailRequestError(403);
   return service.handle(canonical,parsed.data,signal);
  },async close(){closed=true;clearInterval(syncTimer);clearInterval(cleanupTimer);shutdown.abort();await active;await collecting;await objects.destroy();await repository.destroy();}};
}
