import {createHash} from 'node:crypto';import {describe,it,expect,vi} from 'vitest';
import {JEV_EMAIL_TRIAGE_ANSWER_IDS} from '@matrix-os/contracts';
import {mailTestDatabase} from './mail-test-database.js';
import {MailArchiveRepository} from '../../packages/gateway/src/mail/repository.js';
import {createMailService} from '../../packages/gateway/src/mail/service.js';
import {createMailWorker} from '../../packages/gateway/src/mail/worker.js';
import {createMailGmailAdapter} from '../../packages/gateway/src/mail/gmail.js';
import {createMailRoutes} from '../../packages/gateway/src/mail/routes.js';
describe('newsletter user journey over the owner database',()=>{it('connects, retains, classifies, reads, archives with confirmation, undoes and suppresses without source deletion',async()=>{
 const fixture=await mailTestDatabase();const repository=new MailArchiveRepository(fixture.dialect);await repository.bootstrap();
 const content=new Map<string,Buffer>();const objects={put:async(namespace:string,bytes:Uint8Array)=>{const digest=createHash('sha256').update(bytes).digest('hex');content.set(digest,Buffer.from(bytes));return{namespace,digest,sizeBytes:bytes.byteLength};},read:async(object:{digest:string})=>{const bytes=content.get(object.digest);if(!bytes)throw Error('missing');return bytes;}};
 let labels=['INBOX','UNREAD'];let bodies=0;const call=vi.fn(async(_owner:string,_binding:unknown,action:string,params:Record<string,unknown>)=>{
  if(action==='get_profile')return{emailAddress:'a@example.com',historyId:'90071992547409930'};
  if((action==='list_messages'||action==='search'))return{messages:[{id:'provider-one'}]};if(action==='list_history')return{historyId:'90071992547409931',history:[]};
  if(action==='get_metadata')return{id:'provider-one',labelIds:labels,historyId:'90071992547409931'};
  if(action==='get_message'){bodies++;return{id:'provider-one',threadId:'thread-one',internalDate:String(Date.now()-86400000),labelIds:labels,payload:{mimeType:'text/plain',headers:[{name:'Subject',value:'Letters worth keeping'},{name:'From',value:'Sunday Edit <hello@example.test>'}],body:{data:Buffer.from('A thoughtful letter for your reading room.').toString('base64url')}}};}
  if(action==='modify_message'){labels=params.removeLabelIds?labels.filter(l=>l!=='INBOX'):[...new Set([...labels,'INBOX'])];return{id:'provider-one',labelIds:labels};}
  throw Error('unexpected action');
 });
 const transport={inventory:async()=>[{id:'connection-one',service:'gmail',account_email:'a@example.com',account_label:'Personal',status:'active'}],call};
 const evaluate=vi.fn(async()=>({requestId:'jev_req_1234567890',recipe:'email-triage-v1' as const,model:'typesafe/jev' as const,latencyMs:1,answers:JEV_EMAIL_TRIAGE_ANSWER_IDS.map(id=>({id,type:'boolean' as const,probability:id==='newsletter'?.99:0}))}));
 const worker=createMailWorker({repository,objects,ownerId:'owner',jev:{evaluate},fundedReady:async()=>true,authorize:async()=>{},gmailForSource:source=>createMailGmailAdapter({authorize:async()=>{},transport:(action,params)=>call('owner',{connectionId:source.connectionId},action,params)})} as Parameters<typeof createMailWorker>[0]);
 const notify=vi.fn();const service=createMailService({repository,objects,transport,ownerId:'owner',sync:async(source)=>{await worker.sync(source);},notify});
 const app=createMailRoutes({resolveOwner:()=> 'owner',installed:async()=>true,handle:service.handle});
 async function action(type:string,payload:Record<string,unknown>={},appId='edition'){const response=await app.request('/action',{method:'POST',body:JSON.stringify({appId,action:type,payload})});expect(response.status,type).toBe(200);return response.json() as Promise<any>;}
 try{
  await action('connect',{connectionId:'connection-one',expectedEmail:'a@example.com',scope:'personal',historyMonths:3,shareWith:['folio']});
  expect((await action('sources')).sources[0].sharedWith).toEqual(['folio']);
  const listed=await action('messages',{view:'latest'});expect(listed.messages).toHaveLength(1);const message=listed.messages[0];expect(message.classification).toBe('newsletter');expect(evaluate).toHaveBeenCalledOnce();expect(bodies).toBe(1);await repository.setCorrection({ownerId:'owner',accountId:message.sourceId,appId:'edition',id:message.id,baseRevision:message.revision,correction:'not_newsletter'});expect((await action('messages',{view:'library'})).messages).toHaveLength(0);const corrected=await action('message',{id:message.id});await repository.setCorrection({ownerId:'owner',accountId:message.sourceId,appId:'edition',id:message.id,baseRevision:corrected.revision,correction:'newsletter'});
  expect((await action('message',{id:message.id})).text).toContain('thoughtful letter');
  const saved=await action('reading',{id:message.id,baseRevision:0,saved:true});expect(saved.saved).toBe(true);expect(saved.readingRevision).toBe(1);expect(labels).toContain('UNREAD');
  expect((await action('sources',{},'folio')).sources).toHaveLength(1);const shared=await action('message',{id:message.id},'folio');expect(shared.retained.text).toContain('thoughtful letter');expect(shared.text).toBeUndefined();let assembled='',offset=0;for(;;){const chunk=await action('message',{id:message.id,contentOffset:offset,contentLimit:16},'folio');expect(chunk.retained).toBeUndefined();expect(chunk.text).toBeUndefined();expect(chunk.contentVersion).toBe(shared.contentVersion);assembled+=chunk.contentChunk.text;if(chunk.contentChunk.nextOffset===null)break;offset=chunk.contentChunk.nextOffset;}expect(JSON.parse(assembled)).toEqual(shared.retained);expect((await action('sources',{},'atlas')).sources).toHaveLength(0);
  const plan=await action('cleanup-preview',{messageIds:[message.id]});expect(labels).toContain('INBOX');const receipt=await action('cleanup-commit',{planId:plan.id,revision:plan.revision});expect(receipt.archivedCount).toBe(1);expect(labels).toEqual(['UNREAD']);
  const undone=await action('cleanup-undo',{operationId:receipt.id});expect(undone.restoredCount).toBe(1);expect(labels).toContain('INBOX');
  const exported=await action('export',{messageIds:[message.id]});expect(JSON.parse(exported.content).messages[0].retained.source).toBeDefined();
  const current=await action('message',{id:message.id});await action('delete',{messageId:message.id,baseRevision:current.revision});expect((await action('messages',{view:'library'})).messages).toHaveLength(0);
  await action('connect',{connectionId:'connection-one',expectedEmail:'a@example.com',scope:'work',historyMonths:3,shareWith:[]});expect((await action('sources',{},'folio')).sources).toHaveLength(0);expect((await action('sources')).sources[0].scope).toBe('work');
  const source=(await action('sources')).sources[0];expect(source).toMatchObject({retainedCount:0,partialCount:0,classifiedCount:0,reviewPendingCount:0,billedUsage:null,availability:'connected'});await action('sync',{sourceId:source.id});expect(bodies).toBe(1);expect(evaluate).toHaveBeenCalledOnce();expect(labels).toContain('UNREAD');expect(call.mock.calls.filter(c=>c[2]==='modify_message')).toHaveLength(2);
 }finally{await repository.destroy();await fixture.cleanup();}
 },30000);});
