import type { AtsDB } from './ats-db.js';
import type { AtsNotification } from './ats-notifications.js';
export interface AtsSlackFile {key:string;filename:string;bytes:Uint8Array}
export interface AtsSlackContent {identity:string;name:string;email:string;path:string;text:string;files:AtsSlackFile[]}
export function splitSlackText(text:string,limit=2500):string[]{
 const characters=Array.from(text);const parts:string[]=[];
 for(let offset=0;offset<characters.length;offset+=limit)parts.push(characters.slice(offset,offset+limit).join(''));
 return parts.length?parts:['(No message body)'];
}
export async function loadAtsSlackContent(db:AtsDB,payload:AtsNotification,entityKey:string):Promise<AtsSlackContent|null>{
 if(payload.messageId||entityKey.startsWith('mail:')){
  let query=db.executor.selectFrom('ats_inbox_messages').selectAll();
  query=payload.messageId?query.where('id','=',payload.messageId):query.where('message_id','=',entityKey.slice(5));
  const mail=await query.executeTakeFirst();if(!mail)return null;
  if(mail.application_id&&!await db.executor.selectFrom('ats_applications').select('id').where('id','=',mail.application_id).where('deleted_at','is',null).executeTakeFirst())return null;
  const attachments=await db.executor.selectFrom('ats_mail_attachments').selectAll().where('message_id','=',mail.id).orderBy('id').execute();
  const email=mail.applicant_email||mail.sender_email;
  return {identity:email||`unknown:${mail.id}`,name:payload.name,email,path:mail.application_id?`/admin/ats/${mail.application_id}`:'/admin/ats/inbox',
   text:`Email: ${mail.subject}\nFrom: ${mail.sender_name} <${mail.sender_email||'sender unavailable'}>\nReceived: ${mail.received_at}\nOriginal: ${mail.source_url}\n\n${mail.body}`,
   files:attachments.map(file=>({key:file.id,filename:file.filename,bytes:new Uint8Array(file.bytes)}))};
 }
 const id=payload.applicationId||payload.path.match(/^\/admin\/ats\/([a-f0-9-]{36})$/)?.[1];if(!id)return null;
 const app=await db.executor.selectFrom('ats_applications').selectAll().where('id','=',id).where('deleted_at','is',null).executeTakeFirst();if(!app)return null;
 const answers=JSON.parse(app.answers) as Array<{prompt:string;answer:string}>;
 const links=JSON.parse(app.links) as Record<string,string>;
 const historicalFiles=await db.executor.selectFrom('ats_mail_attachments').innerJoin('ats_inbox_messages','ats_inbox_messages.id','ats_mail_attachments.message_id').select(['ats_mail_attachments.id','filename','bytes']).where('application_id','=',app.id).where('ats_inbox_messages.message_id','like','legacy-%').execute();
 const files=app.resume_filename?[{key:`resume:${app.id}`,filename:app.resume_filename,bytes:new Uint8Array(app.resume_bytes)}]:[];
 files.push(...historicalFiles.map(file=>({key:file.id,filename:file.filename,bytes:new Uint8Array(file.bytes)})));
 return {identity:app.candidate_email,name:app.candidate_name,email:app.candidate_email,path:`/admin/ats/${app.id}`,
  text:[`Application: ${app.role_slug}`,`Submitted: ${app.created_at}`,`Email: ${app.candidate_email}`,app.phone?`Phone: ${app.phone}`:'',`Location: ${app.location}`,`Availability: ${app.availability}`,
    ...Object.entries(links).map(([label,url])=>`${label}: ${url}`),'',...answers.map(answer=>`${answer.prompt}\n${answer.answer}`)].filter(Boolean).join('\n\n'),files};
}
