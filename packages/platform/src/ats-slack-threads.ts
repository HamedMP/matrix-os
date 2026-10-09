import { createHash,randomUUID } from 'node:crypto';
import type { AtsDB } from './ats-db.js';
import { AtsDeliveryPendingError,enqueueAtsNotification,type AtsNotification } from './ats-notifications.js';
import { loadAtsSlackContent,splitSlackText,type AtsSlackFile } from './ats-slack-content.js';
export interface AtsSlackTransport {
 post(input:{key:string;text:string;threadTs?:string;reviewUrl?:string}):Promise<{ts:string}>;
 upload(input:AtsSlackFile&{threadTs:string}):Promise<{fileId:string}>;
}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export function createAtsThreadSender(db:AtsDB,transport:AtsSlackTransport,channel:string,siteUrl:string){
 if(!/^C[A-Z0-9]{8,}$/.test(channel)||new URL(siteUrl).protocol!=='https:')throw Error('Invalid recruiting Slack configuration');
 return async(payload:AtsNotification,context:{entityKey:string;jobId:string}):Promise<{ts:string}>=>{
  const content=await loadAtsSlackContent(db,payload,context.entityKey);if(!content)return {ts:'0.0'};
  const threadKey=hash(`${channel}:${content.identity.toLowerCase()}`);const leaseToken=randomUUID();const now=new Date().toISOString();
  const thread=await db.transaction(async trx=>{
   await trx.executor.insertInto('ats_slack_threads').values({thread_key:threadKey,root_ts:null,lease_token:null,lease_until:null}).onConflict(oc=>oc.column('thread_key').doNothing()).execute();
   return trx.executor.updateTable('ats_slack_threads').set({lease_token:leaseToken,lease_until:new Date(Date.parse(now)+5*60_000).toISOString()})
    .where('thread_key','=',threadKey).where(eb=>eb.or([eb('lease_until','is',null),eb('lease_until','<=',now)]))
    .returningAll().executeTakeFirst();
  });
  if(!thread)throw new AtsDeliveryPendingError();
  try{
   let rootTs=thread.root_ts;const reviewUrl=new URL(content.path,new URL(siteUrl).origin).href;
   if(!rootTs){
    rootTs=(await transport.post({key:`thread:${threadKey}`,text:`Applicant: ${content.name||content.email||'Sender unavailable'}\n${content.email}\nApplications, emails and attachments are collected in this thread.`,reviewUrl})).ts;
    await db.executor.updateTable('ats_slack_threads').set({root_ts:rootTs}).where('thread_key','=',threadKey).where('lease_token','=',leaseToken).execute();
   }
   const prefix=hash(`${channel}:${context.entityKey}`);let delivered=0;
   const complete=async(part:string,send:()=>Promise<string>)=>{
    const partKey=`${prefix}:${part}`;
    if(await db.executor.selectFrom('ats_slack_parts').select('part_key').where('part_key','=',partKey).executeTakeFirst())return;
    // Bound each continuation so an arbitrarily long email cannot outlive its lease.
    if(delivered>=4)throw new AtsDeliveryPendingError();
    const result=await send();await db.executor.insertInto('ats_slack_parts').values({part_key:partKey,result_id:result,completed_at:new Date().toISOString()}).onConflict(oc=>oc.column('part_key').doNothing()).execute();delivered++;
   };
   const chunks=splitSlackText(content.text);
   for(let index=0;index<chunks.length;index++)await complete(`text:${index}`,async()=> (await transport.post({key:`${prefix}:text:${index}`,text:chunks[index],threadTs:rootTs!,...(index===0?{reviewUrl}:{})})).ts);
   for(const file of content.files)await complete(`file:${file.key}`,async()=> (await transport.upload({...file,key:`${prefix}:file:${file.key}`,threadTs:rootTs!})).fileId);
   return {ts:rootTs};
  }finally{await db.executor.updateTable('ats_slack_threads').set({lease_token:null,lease_until:null}).where('thread_key','=',threadKey).where('lease_token','=',leaseToken).execute();}
 };
}
export async function enqueueAtsHistory(db:AtsDB,input:{kind:'applications'|'emails';after:string;limit:number},at:string){
 await db.ready;
 return db.transaction(async trx=>{
  if(input.kind==='applications'){
   const rows=await trx.executor.selectFrom('ats_applications').select(['id','candidate_name','candidate_email','role_slug','source','created_at']).where('deleted_at','is',null).where('id','>',input.after).orderBy('id').limit(input.limit).execute();
   for(const app of rows)await enqueueAtsNotification(trx,`application:${app.id}`,{name:app.candidate_name,email:app.candidate_email,role:app.role_slug,path:`/admin/ats/${app.id}`,source:app.source==='legacy'?'legacy':'careers_page',applicationId:app.id},app.created_at);
   return {enqueued:rows.length,next:rows.length===input.limit?rows.at(-1)!.id:null};
  }
  const rows=await trx.executor.selectFrom('ats_inbox_messages').selectAll().where('id','>',input.after)
   .where('message_id','not like','legacy-%')
   .where(eb=>eb.or([eb('application_id','is',null),eb.exists(eb.selectFrom('ats_applications').select('id').whereRef('ats_applications.id','=','ats_inbox_messages.application_id').where('deleted_at','is',null))]))
   .orderBy('id').limit(input.limit).execute();
  for(const mail of rows)await enqueueAtsNotification(trx,`mail:${mail.message_id}`,{name:mail.sender_name,email:mail.sender_email,role:mail.subject.slice(0,100),path:mail.application_id?`/admin/ats/${mail.application_id}`:'/admin/ats/inbox',source:'group_email',messageId:mail.id},mail.received_at);
  return {enqueued:rows.length,next:rows.length===input.limit?rows.at(-1)!.id:null};
 });
}
