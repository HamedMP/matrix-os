import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createTestAtsDb, destroyTestAtsDb } from './ats-db-test-helper.js';
import type { AtsDB } from '../../packages/platform/src/ats-db.js';
import { importAtsMail } from '../../packages/platform/src/ats-mail.js';
import { createAtsThreadSender, enqueueAtsHistory } from '../../packages/platform/src/ats-slack-threads.js';
import { deliverAtsNotifications, AtsSlackRetryError } from '../../packages/platform/src/ats-notifications.js';
import { importLegacyCandidate } from '../../packages/platform/src/ats-legacy.js';

let db: AtsDB;
const at = '2026-10-09T10:00:00.000Z';
const mail = { messageId:'message1', threadId:'', senderName:'Ada', senderEmail:'ada@example.com', subject:'Engineer application', body:'My complete application answer', receivedAt:at, sourceUrl:'https://groups.google.com/a/finna.ai/g/careers' };
beforeEach(async()=>{({db}=await createTestAtsDb());});
afterEach(async()=>{await destroyTestAtsDb(db);});
function setup(){let n=0;const post=vi.fn(async()=>({ts:`123.${++n}`}));const upload=vi.fn(async()=>({fileId:`F${++n}`}));return {post,upload,send:createAtsThreadSender(db,{post,upload},'C12345678','https://matrix-os.com')};}
it('puts all email content and arbitrary attachments into the same applicant thread across roles',async()=>{
 const first=await importAtsMail(db,{...mail,body:'a'.repeat(7000),attachments:[{filename:'portfolio.png',contentType:'image/png',base64:Buffer.from('image').toString('base64')}]},at);
 await importAtsMail(db,{...mail,messageId:'message2',subject:'Another role',body:'Follow-up answer'},at);
 const {post,upload,send}=setup();await deliverAtsNotifications(db,send,at);
 const roots=post.mock.calls.map(([p])=>p).filter(p=>!p.threadTs);
 expect(roots).toHaveLength(1);
 const replies=post.mock.calls.map(([p])=>p).filter(p=>p.threadTs);
 expect(replies.every(p=>p.threadTs==='123.1')).toBe(true);
 expect(replies.map(p=>p.text).join('')).toContain('a'.repeat(7000));
 expect(replies.map(p=>p.text).join('')).toContain('Follow-up answer');
 expect(upload).toHaveBeenCalledWith(expect.objectContaining({threadTs:'123.1',filename:'portfolio.png',bytes:expect.any(Uint8Array),key:expect.any(String)}));
 expect(first.applicant_email).toBe('ada@example.com');
});
it('uses the applicant thread for a team reply and keeps other applicants separate',async()=>{
 await importAtsMail(db,mail,at);
 await importAtsMail(db,{...mail,messageId:'reply',threadId:mail.messageId,senderEmail:'hamed@finna.ai',body:'Our reply'},at);
 await importAtsMail(db,{...mail,messageId:'another',senderEmail:'other@example.com'},at);
 const {post,send}=setup();await deliverAtsNotifications(db,send,at);await deliverAtsNotifications(db,send,'2026-10-09T10:01:00.000Z');
 expect(post.mock.calls.map(([p])=>p).filter(p=>!p.threadTs)).toHaveLength(2);
 expect(post.mock.calls.find(([p])=>p.text.includes('Our reply'))?.[0].threadTs).toBe('123.1');
});
it('resumes after a failed attachment without reposting completed content or files',async()=>{
 await importAtsMail(db,{...mail,attachments:[{filename:'one.png',contentType:'image/png',base64:Buffer.from('one').toString('base64')},{filename:'two.png',contentType:'image/png',base64:Buffer.from('two').toString('base64')}]},at);
 const {post,upload,send}=setup();upload.mockResolvedValueOnce({fileId:'F1'}).mockRejectedValueOnce(Error('offline'));
 await deliverAtsNotifications(db,send,at);expect(post).toHaveBeenCalledTimes(2);
 await deliverAtsNotifications(db,send,'2026-10-09T10:10:00.000Z');expect(post).toHaveBeenCalledTimes(2);expect(upload).toHaveBeenCalledTimes(3);
 const successfulFile=upload.mock.calls[0][0].key;expect(upload.mock.calls.filter(([file])=>file.key===successfulFile)).toHaveLength(1);
});
it('serializes concurrent deliveries for the same applicant',async()=>{
 await importAtsMail(db,mail,at);const row=await db.executor.selectFrom('ats_notification_outbox').selectAll().executeTakeFirstOrThrow();const payload=JSON.parse(row.payload);
 const {post,send}=setup();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});post.mockImplementationOnce(async()=>{await gate;return {ts:'123.1'};});
 const first=send(payload,{entityKey:row.entity_key,jobId:row.id});await vi.waitFor(()=>expect(post).toHaveBeenCalledTimes(1));
 await expect(send(payload,{entityKey:row.entity_key,jobId:'other'})).rejects.toMatchObject({name:'AtsDeliveryPendingError'});release();await first;expect(post.mock.calls.filter(([p])=>!p.threadTs)).toHaveLength(1);
});
it('backfills existing application answers and CVs once, including archived applicants',async()=>{
 const app=await importLegacyCandidate(db,{legacyKey:'legacy1',name:'Ada',email:'ada@example.com',roleSlug:'associate',stage:'applied',disposition:'archived',summary:'Saved summary',createdAt:at,notes:[],emails:[],attachments:[{filename:'legacy.pdf',contentType:'application/pdf',base64:Buffer.from('%PDF-original').toString('base64')}]},'user_owner',at);
 await db.executor.updateTable('ats_applications').set({answers:JSON.stringify([{prompt:'Why Matrix?',answer:'My entire answer'}]),resume_filename:'cv.pdf',resume_content_type:'application/pdf',resume_bytes:Buffer.from('%PDF-1.7')}).where('id','=',app.id).execute();
 expect(await enqueueAtsHistory(db,{kind:'applications',after:'',limit:100},at)).toMatchObject({enqueued:1});
 await enqueueAtsHistory(db,{kind:'applications',after:'',limit:100},at);
 const {post,upload,send}=setup();await deliverAtsNotifications(db,send,at);
 expect(post.mock.calls.map(([p])=>p.text).join('\n')).toContain('Why Matrix?\nMy entire answer');
 expect(upload).toHaveBeenCalledTimes(2);
 expect(await db.executor.selectFrom('ats_notification_outbox').selectAll().execute()).toHaveLength(1);
});
it('skips soft-deleted records even when notification was queued before deletion',async()=>{
 const app=await importLegacyCandidate(db,{legacyKey:'legacy1',name:'Ada',email:'ada@example.com',roleSlug:'associate',stage:'applied',disposition:'active',summary:'',createdAt:at,notes:[],emails:[],attachments:[]},'user_owner',at);
 await enqueueAtsHistory(db,{kind:'applications',after:'',limit:100},at);
 await db.executor.updateTable('ats_applications').set({deleted_at:at}).where('id','=',app.id).execute();
 const {post,send}=setup();await deliverAtsNotifications(db,send,at);expect(post).not.toHaveBeenCalled();
});
it('backfills full content when an earlier minimal notification was already sent',async()=>{
 const row=await importAtsMail(db,mail,at);await db.executor.updateTable('ats_notification_outbox').set({sent_at:at,slack_ts:'old.1'}).execute();
 await enqueueAtsHistory(db,{kind:'emails',after:'',limit:100},at);const {post,send}=setup();await deliverAtsNotifications(db,send,at);expect(post.mock.calls.map(([p])=>p.text).join('')).toContain(mail.body);
});
it('defers a team reply until its applicant arrives, then uses the applicant thread',async()=>{
 await importAtsMail(db,{...mail,messageId:'reply',threadId:'late-parent',senderEmail:'hamed@finna.ai',body:'Team reply'},at);const {post,send}=setup();await deliverAtsNotifications(db,send,at);expect(post).not.toHaveBeenCalled();
 await importAtsMail(db,{...mail,messageId:'late-parent'},at);await deliverAtsNotifications(db,send,'2026-10-09T10:02:00.000Z');expect(post.mock.calls.filter(([p])=>!p.threadTs)).toHaveLength(1);expect(post.mock.calls.find(([p])=>!p.threadTs)?.[0].text).toContain('ada@example.com');
});
it('starts Slack Retry-After at the response time, after a slow delivery',async()=>{
 await importAtsMail(db,mail,at);
 const responseAt=Date.parse(at)+240_000;const clock=vi.spyOn(Date,'now').mockReturnValue(responseAt);
 try{
  await deliverAtsNotifications(db,async()=>{throw new AtsSlackRetryError(60_000);},at);
  const job=await db.executor.selectFrom('ats_notification_outbox').selectAll().executeTakeFirstOrThrow();
  expect(job.available_at).toBe(new Date(responseAt+60_000).toISOString());expect(job.sent_at).toBeNull();
 }finally{clock.mockRestore();}
});
