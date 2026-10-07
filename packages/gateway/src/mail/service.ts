import {createHash} from 'node:crypto';
import type {MailActionRequest} from '@matrix-os/contracts';
import {MailArchiveRepository} from './repository.js';
import type {MailObjectStore} from './objects.js';
import type {ArchivedMessage,MailSource,MailConsumerScope} from './types.js';
import type {MailTransport} from './transport.js';
import {MailRequestError} from './routes.js';
import {mailCursor,messageCategory,readingText} from './presentation.js';
import {createMailCleanupAdapter,cleanupReceipt} from './cleanup-adapter.js';
interface Options{repository:MailArchiveRepository;objects:Pick<MailObjectStore,'read'>;transport:MailTransport;ownerId:string;sync(source:MailSource):Promise<void>|void;notify():void;now?:()=>Date}
export function createMailService(o:Options){
 const now=o.now??(()=>new Date());const repo=o.repository;
 const sources=(appId:string)=>repo.listGrantedSources({ownerId:o.ownerId,appId});
 async function sourceFor(appId:string,id:string){const source=(await sources(appId)).find(s=>s.accountId===id);if(!source)throw new MailRequestError(403);return source;}
 async function messageFor(appId:string,id:string){const message=await repo.getGrantedMessageById({ownerId:o.ownerId,appId,id});if(!message)throw new MailRequestError(404);return message;}
 function scope(appId:string,message:ArchivedMessage):MailConsumerScope{return{ownerId:o.ownerId,accountId:message.accountId,appId};}
 async function project(appId:string,message:ArchivedMessage,withBody=false,exportBody=false){
  const reading=await repo.getReadingState({...scope(appId,message),id:message.id});if(!reading)throw new MailRequestError(404);
  let text:string|undefined;let retained:unknown;
  if(withBody&&message.object){
   const lease=await repo.leaseObject({...scope(appId,message),id:message.id});if(!lease)throw new MailRequestError(404);
   try{retained=JSON.parse((await o.objects.read(lease.object)).toString('utf8'));text=readingText(retained as {text?:unknown;html?:unknown});
    // Recheck revocation after disk read; the file capability is not a grant.
    if(!await repo.readMessage({...scope(appId,message),id:message.id}))throw new MailRequestError(403);
   }finally{await repo.releaseObjectLease({...lease.object,token:lease.token});}
  }
  return{id:message.id,sourceId:message.accountId,subject:message.subject.slice(0,1000),sender:message.sender,publication:message.sender.replace(/\s*<[^>]+>\s*$/,'').replace(/^"|"$/g,''),receivedAt:message.receivedAt,excerpt:(message.textSnippet??'').slice(0,4000),...(withBody&&appId==='edition'?{text:text??'This message has not been downloaded completely.'}:{}),contentVersion:message.object?.digest??`partial-${message.revision}`,classification:messageCategory(message),saved:reading.saved,read:reading.read,progress:reading.progress,revision:message.revision,readingRevision:reading.revision,partial:!message.object,...((appId!=='edition'||exportBody)&&withBody?{retained}: {})};
 }
 async function handle(owner:string,request:MailActionRequest,signal:AbortSignal):Promise<unknown>{
  if(owner!==o.ownerId||(request.appId!=='edition'&&!['sources','messages','message'].includes(request.action)))throw new MailRequestError(403);
  signal.throwIfAborted();const appId=request.appId;
  switch(request.action){
   case 'sources':{
    const list=await sources(appId);
    const sharing=appId==='edition'?await Promise.all(['folio','atlas'].map(async consumer=>({consumer,accounts:(await sources(consumer)).map(source=>source.accountId)}))):[];
    let inventory:Awaited<ReturnType<MailTransport['inventory']>>|null=null;
    try{inventory=await o.transport.inventory(owner,signal);}catch(error){signal.throwIfAborted();console.warn('[mail] Source availability unknown',{errorName:error instanceof Error?error.name:'UnknownError'});}
    return{sources:await Promise.all(list.map(async source=>{
     const [job,usage]=await Promise.all([repo.getSyncJob(source),repo.getUsageSummary({...source,appId})]);
     const availability=inventory===null?'unknown':inventory.some(c=>c.id===source.connectionId&&c.account_email===source.email&&c.account_label===source.accountLabel&&c.status==='active')?'connected':'disconnected';
     return{id:source.accountId,connectionId:source.connectionId,email:source.email,label:source.accountLabel,scope:source.group,sharedWith:sharing.filter(grant=>grant.accounts.includes(source.accountId)).map(grant=>grant.consumer),state:source.paused?'paused':job?.status??'not_synced',availability,coverageStart:job?.rangeFrom,coverageEnd:job?.rangeUntil,...(typeof job?.checkpoint?.completedAt==='string'?{lastSyncedAt:job.checkpoint.completedAt}:{}),...(job?.checkpoint?.lastError==='sync_unavailable'?{syncError:'sync_unavailable',failureAt:job.checkpoint.failureAt}:{}),usedBytes:source.usedBytes,quotaBytes:source.quotaBytes,...usage};
    })),cacheScope:createHash('sha256').update(JSON.stringify([o.ownerId,list.map(s=>[s.accountId,s.namespace])])).digest('hex')};
   }
   case 'connect':{
    const p=request.payload;const inventory=await o.transport.inventory(owner,signal);const connection=inventory.find(c=>c.id===p.connectionId&&c.account_email===p.expectedEmail&&c.status==='active');if(!connection)throw new MailRequestError(403);
    const binding={service:'gmail' as const,connectionId:connection.id,accountLabel:connection.account_label,expectedEmail:p.expectedEmail};
    const profile=await o.transport.call(owner,binding,'get_profile',{},signal);if(!profile||typeof profile!=='object'||!('emailAddress'in profile)||String(profile.emailAddress).toLowerCase()!==p.expectedEmail.toLowerCase())throw new MailRequestError(403);
    const until=now();const from=new Date(until);const day=from.getUTCDate();from.setUTCDate(1);from.setUTCMonth(from.getUTCMonth()-p.historyMonths);from.setUTCDate(Math.min(day,new Date(Date.UTC(from.getUTCFullYear(),from.getUTCMonth()+1,0)).getUTCDate()));
    const accountId=createHash('sha256').update(connection.id).digest('hex');
    const source=await repo.kysely.transaction().execute(async trx=>{
     const repository=new MailArchiveRepository(trx);const registered=await repository.registerSource({ownerId:owner,accountId,connectionId:connection.id,email:p.expectedEmail,provider:'gmail',accountLabel:connection.account_label,group:p.scope});
     await repository.grantConsumer({ownerId:owner,accountId,appId:'edition',from:from.toISOString(),purpose:'newsletter'});
     for(const consumer of ['folio','atlas'] as const){if(p.shareWith?.includes(consumer))await repository.grantConsumer({ownerId:owner,accountId,appId:consumer,from:from.toISOString(),purpose:consumer==='folio'?'expenses':'trips'});else await repository.revokeConsumer({ownerId:owner,accountId,appId:consumer});}
     await repository.enqueueSync({ownerId:owner,accountId,rangeFrom:from.toISOString(),rangeUntil:until.toISOString()});return registered;
    });
    o.notify();await o.sync(source);return{id:source.accountId,state:'pending'};
   }
   case 'retention':{const source=await sourceFor(appId,request.payload.sourceId);const result=await repo.changeRetention({...source,appId,mode:request.payload.mode});o.notify();return result;}
   case 'sync':{const source=await sourceFor(appId,request.payload.sourceId);if(source.paused)throw new MailRequestError(409);const job=await repo.getSyncJob(source);if(!job)throw new MailRequestError(409);if(job.status==='completed')await repo.enqueueSync({...source,rangeFrom:job.rangeFrom,rangeUntil:job.rangeUntil});await o.sync(source);return{state:'pending'};}
   case 'messages':{
    const p=request.payload;const limit=p.limit??100;const cursor=p.cursor?mailCursor.decode(p.cursor):undefined;const list=(await sources(appId)).filter(s=>(!p.sourceId||s.accountId===p.sourceId)&&(!p.scope||p.scope==='all'||p.scope===s.group));
    if(list.length>20)throw new MailRequestError(400);
    const rows=(await Promise.all(list.map(s=>repo.listMessages({...s,appId,limit,search:p.query,before:cursor?.date,beforeId:cursor?.id})))).flat().sort((a,b)=>b.receivedAt.localeCompare(a.receivedAt)||b.id.localeCompare(a.id));
    const batch=rows.slice(0,limit);const projected=await Promise.all(batch.map(m=>project(appId,m)));
    const visible=projected.filter(m=>appId!=='edition'||(p.view==='review'?m.classification==='review':m.classification==='newsletter')&&(p.view!=='saved'||m.saved)&&(p.view!=='unread'||!m.read));
    const last=batch.at(-1);return{messages:visible,...(last&&rows.length>=limit?{nextCursor:mailCursor.encode({date:last.receivedAt,id:last.id})}:{})};
   }
   case 'message':{
    const p=request.payload;const value=await project(appId,await messageFor(appId,p.id),true);
    if(p.contentOffset===undefined&&p.contentLimit===undefined)return value;
    const serialized=JSON.stringify(appId==='edition'?{text:value.text}:value.retained);
    if(typeof serialized!=='string')throw new MailRequestError(404);
    const offset=p.contentOffset??0;if(offset>serialized.length)throw new MailRequestError(400);
    const end=Math.min(serialized.length,offset+(p.contentLimit??16000));
    const {text:_text,retained:_retained,...metadata}=value;
    return{...metadata,contentChunk:{encoding:'json',offset,nextOffset:end<serialized.length?end:null,totalLength:serialized.length,text:serialized.slice(offset,end)}};
   }
   case 'reading':{
    const p=request.payload;const message=await messageFor(appId,p.id);const current=await repo.getReadingState({...scope(appId,message),id:p.id});if(!current)throw new MailRequestError(404);
    const next=await repo.saveReadingState({...scope(appId,message),id:p.id,baseRevision:p.baseRevision,saved:p.saved??current.saved,read:p.read??current.read,progress:p.progress??current.progress});if(!next)throw new MailRequestError(409);o.notify();return project(appId,message);
   }
   case 'correct':{const p=request.payload;const message=await messageFor(appId,p.id);if(!await repo.setCorrection({...scope(appId,message),id:p.id,baseRevision:p.baseRevision,correction:p.classification==='newsletter'?'newsletter':'not_newsletter'}))throw new MailRequestError(409);o.notify();return project(appId,await messageFor(appId,p.id));}
   case 'delete':{const p=request.payload;const message=await messageFor(appId,p.messageId);if(!await repo.suppressGrantedMessage({...scope(appId,message),id:p.messageId,baseRevision:p.baseRevision}))throw new MailRequestError(409);o.notify();return{deleted:true};}
   case 'export':{
    const messages=[];let size=0;for(const id of request.payload.messageIds){signal.throwIfAborted();const message=await project(appId,await messageFor(appId,id),true,true);const bytes=JSON.stringify(message);size+=Buffer.byteLength(bytes);if(size>3*1024*1024)throw new MailRequestError(400);messages.push(message);}return{filename:'edition-emails.json',mimeType:'application/json',content:JSON.stringify({version:1,exportedAt:now().toISOString(),messages})};
   }
   case 'cleanup-recovery':{
    const list=await repo.listRecoverableCleanupOperations({ownerId:o.ownerId,appId,limit:20});
    signal.throwIfAborted();const granted=await sources(appId);
    const operations=list.flatMap(({operation,messageIds})=>{
     const source=granted.find(s=>s.accountId===operation.plan.accountId);if(!source)return[];
     const binding=createHash('sha256').update(JSON.stringify({service:'gmail',connectionId:source.connectionId,accountLabel:source.accountLabel,expectedEmail:source.email})).digest('hex');
     if(operation.plan.binding!==binding)return[];
     const {id,state,archivedCount,restoredCount}=cleanupReceipt(operation);
     return[{plan:{id:operation.plan.id,revision:0,messageIds,expiresAt:new Date(operation.plan.expiresAt).toISOString()},receipt:{id,state,archivedCount,restoredCount}}];
    });return{operations};
   }
   case 'cleanup-preview':{
    const selected=await Promise.all(request.payload.messageIds.map(id=>messageFor(appId,id)));const accountId=selected[0]!.accountId;if(selected.some(m=>m.accountId!==accountId))throw new MailRequestError(400);const source=await sourceFor(appId,accountId);const plan=await createMailCleanupAdapter(repo,o.objects,o.transport,source,signal).preview(selected.map(m=>m.messageId));return{id:plan.id,revision:0,messageIds:request.payload.messageIds,expiresAt:new Date(plan.expiresAt).toISOString()};
   }
   case 'cleanup-commit':case 'cleanup-undo':{
    for(const source of await sources(appId)){
     const plan=request.action==='cleanup-commit'?await repo.getPlan({...source,planId:request.payload.planId}):null;
     const operation=request.action==='cleanup-undo'?await repo.getOperation({...source,operationId:request.payload.operationId}):null;
     if(!plan&&!operation)continue;const adapter=createMailCleanupAdapter(repo,o.objects,o.transport,source,signal);
     if(request.action==='cleanup-commit'&&request.payload.revision!==0)throw new MailRequestError(409);
     const result=plan?await adapter.commit(plan.id,plan.hash):await adapter.undo(operation!.id);if(!result)throw new MailRequestError(409);o.notify();return cleanupReceipt(result);
    }throw new MailRequestError(404);
   }
  }
 }
 return{handle};
}
