import {createHash} from 'node:crypto';
import {z} from 'zod/v4';
import type {AtsDB} from './ats-db.js';
import {AtsSlackRetryError} from './ats-notifications.js';
import type {AtsSlackTransport} from './ats-slack-threads.js';
const uuid=(key:string)=>{const hex=createHash('sha256').update(key).digest('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;};
export function createAtsSlackTransport(token:string,channel:string,db:AtsDB):AtsSlackTransport{
 if(!token||!/^C[A-Z0-9]{8,}$/.test(channel))throw Error('Incomplete recruiting Slack configuration');
 async function api(method:string,body:Record<string,unknown>){
  // Slack's external file endpoints reject JSON metadata with missing-field errors.
  const form=method==='files.getUploadURLExternal'||method==='files.completeUploadExternal';
  const encoded=form?new URLSearchParams(Object.entries(body).map(([key,value])=>
   [key,typeof value==='object'?JSON.stringify(value):String(value)])).toString():JSON.stringify(body);
  const contentType=form?'application/x-www-form-urlencoded;charset=UTF-8':'application/json;charset=UTF-8';
  const response=await fetch(`https://slack.com/api/${method}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':contentType},body:encoded,signal:AbortSignal.timeout(10_000),redirect:'error'});
  if(response.status===429){const retry=Number(response.headers.get('retry-after'));throw new AtsSlackRetryError(Math.min(3600,Math.max(60,Number.isFinite(retry)?retry:60))*1000);}
  const result=z.object({ok:z.boolean()}).passthrough().parse(await response.json());
  if(!response.ok||!result.ok)throw Error('Recruiting Slack delivery unavailable');return result;
 }
 return {
  async post(input){
   const chunks=Array.from(input.text);const blocks=[];
   for(let offset=0;offset<chunks.length;offset+=2500)blocks.push({type:'section',text:{type:'plain_text',text:chunks.slice(offset,offset+2500).join('')}});
   if(input.reviewUrl)blocks.push({type:'actions',elements:[{type:'button',text:{type:'plain_text',text:'Review in ATS'},url:input.reviewUrl}]});
   const result=await api('chat.postMessage',{channel,client_msg_id:uuid(input.key),text:input.text,thread_ts:input.threadTs,mrkdwn:false,parse:'none',unfurl_links:false,unfurl_media:false,blocks});
   return z.object({ts:z.string().regex(/^\d+\.\d+$/)}).parse(result);
  },
  async upload(input){
   await db.ready;
   const uploadKey=createHash('sha256').update(`${channel}:${input.key}`).digest('hex');
   let allocation=await db.executor.selectFrom('ats_slack_uploads').selectAll().where('upload_key','=',uploadKey).executeTakeFirst();
   if(!allocation){
    const fresh=z.object({upload_url:z.url(),file_id:z.string().regex(/^F[A-Z0-9]+$/)}).parse(await api('files.getUploadURLExternal',{filename:input.filename,length:input.bytes.byteLength}));
    const target=new URL(fresh.upload_url);if(target.protocol!=='https:'||target.hostname!=='files.slack.com'||target.username||target.password)throw Error('Unexpected recruiting upload destination');
    await db.executor.insertInto('ats_slack_uploads').values({upload_key:uploadKey,file_id:fresh.file_id,upload_url:fresh.upload_url,uploaded_at:null,completed_at:null}).onConflict(oc=>oc.column('upload_key').doNothing()).execute();
    allocation=await db.executor.selectFrom('ats_slack_uploads').selectAll().where('upload_key','=',uploadKey).executeTakeFirstOrThrow();
   }
   if(allocation.completed_at)return {fileId:allocation.file_id};
   if(!allocation.uploaded_at){
    if(!allocation.upload_url)throw Error('Recruiting attachment requires recovery');
    const target=new URL(allocation.upload_url);if(target.protocol!=='https:'||target.hostname!=='files.slack.com'||target.username||target.password)throw Error('Unexpected recruiting upload destination');
    const response=await fetch(target,{method:'POST',headers:{'content-type':'application/octet-stream'},body:new Uint8Array(input.bytes).buffer,signal:AbortSignal.timeout(30_000),redirect:'error'});
    if(!response.ok)throw Error('Recruiting attachment upload unavailable');
    await db.executor.updateTable('ats_slack_uploads').set({uploaded_at:new Date().toISOString(),upload_url:null}).where('upload_key','=',uploadKey).execute();
   }
   await api('files.completeUploadExternal',{files:[{id:allocation.file_id,title:input.filename}],channel_id:channel,thread_ts:input.threadTs});
   await db.executor.updateTable('ats_slack_uploads').set({completed_at:new Date().toISOString()}).where('upload_key','=',uploadKey).execute();
   return {fileId:allocation.file_id};
  },
 };
}
