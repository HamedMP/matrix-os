import {createHash} from 'node:crypto';
import type {MailArchiveRepository} from './repository.js';
import type {MailSource} from './types.js';
import type {MailTransport} from './transport.js';
import type {MailObjectStore} from './objects.js';
import {createMailGmailAdapter} from './gmail.js';
import {messageCategory} from './presentation.js';
import {NEWSLETTER_POLICY_VERSION} from './policy.js';
import {MailRequestError} from './routes.js';
import {previewNewsletterCleanup,commitNewsletterCleanup,undoNewsletterCleanup,type CleanupStore,type CleanupOperation} from './cleanup.js';
export function createMailCleanupAdapter(repository:MailArchiveRepository,objects:Pick<MailObjectStore,'read'>,transport:MailTransport,source:MailSource,signal:AbortSignal){
 const key={ownerId:source.ownerId,accountId:source.accountId};
 const binding={service:'gmail' as const,connectionId:source.connectionId,accountLabel:source.accountLabel,expectedEmail:source.email};
 async function authorize(){
  signal.throwIfAborted();
  const granted=await repository.listGrantedSources({ownerId:source.ownerId,appId:'edition'});
  if(!granted.some(s=>s.accountId===source.accountId&&s.connectionId===source.connectionId&&s.email===source.email))throw new MailRequestError(403);
  const inventory=await transport.inventory(source.ownerId,signal);
  if(!inventory.some(c=>c.id===source.connectionId&&c.account_label===source.accountLabel&&c.account_email===source.email&&c.status==='active'))throw new MailRequestError(403);
 }
 const gmail=createMailGmailAdapter({authorize,signal,transport:(action,params,callSignal)=>transport.call(source.ownerId,binding,action,params,callSignal)});
 const store:CleanupStore={
  async getMessage(messageId){
   const message=await repository.getStoredMessage({...key,messageId});if(!message)return null;
   if(!await repository.readMessage({...key,appId:'edition',id:message.id}))return null;
   if(message.object){
    const lease=await repository.leaseObject({...key,appId:'edition',id:message.id});if(!lease)return null;
    try{await objects.read(lease.object);if(!await repository.readMessage({...key,appId:'edition',id:message.id}))return null;}
    finally{await repository.releaseObjectLease({...lease.object,token:lease.token});}
   }
   return {messageId,contentDigest:message.object?.digest??'',ready:!!message.object&&!message.partialReason,category:messageCategory(message),revision:message.revision,policyVersion:NEWSLETTER_POLICY_VERSION};
  },
  savePlan:plan=>repository.savePlan(plan),getPlan:planId=>repository.getPlan({...key,planId}),claimOperation:(plan,existingOnly)=>repository.claimOperation(plan,existingOnly),
  transition:(operationId,messageId,from,next)=>repository.transition({...key,operationId,messageId,from,next}),
  getOperation:operationId=>repository.getOperation({...key,operationId}),
 };
 const dependencies={store,gmail,authorize,...key,binding:createHash('sha256').update(JSON.stringify(binding)).digest('hex'),signal};
 return {preview:(messageIds:string[])=>previewNewsletterCleanup({...dependencies,messageIds}),commit:(planId:string,hash:string)=>commitNewsletterCleanup({...dependencies,planId,expectedHash:hash}),undo:(operationId:string)=>undoNewsletterCleanup({...dependencies,operationId})};
}
export function cleanupReceipt(operation:CleanupOperation){
 const archivedCount=operation.entries.filter(e=>e.state==='confirmed').length;
 const restoredCount=operation.entries.filter(e=>e.state==='undone').length;
 const unknown=operation.entries.some(e=>['unknown','dispatching','undo_pending'].includes(e.state));
 return {id:operation.id,state:unknown?'needs_verification':restoredCount===operation.entries.length?'undone':archivedCount===operation.entries.length?'completed':'partial',archivedCount,restoredCount,entries:operation.entries.map(e=>({messageId:e.messageId,state:e.state}))};
}
