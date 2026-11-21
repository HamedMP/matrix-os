import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPlatformDb, insertUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createSiteEmailInvitations, revokeSiteEmailInvitation } from '../../packages/platform/src/sites/email-invitations.js';
import { createSiteInvitationDeliveryWorker } from '../../packages/platform/src/sites/invitation-delivery.js';

const postgresUrl=process.env.MATRIX_TEST_POSTGRES_URL;
const postgres=postgresUrl?describe:describe.skip;
postgres('site invitation delivery outbox across independent PostgreSQL connections',()=>{
 const schema=`site_mail_${randomUUID().replaceAll('-','')}`;
 let admin:pg.Pool,dbA:PlatformDB,dbB:PlatformDB;
 const ownerBase={ownerId:'user_mail_owner',machineId:'mail-owner-machine'};
 function url(name:string){const parsed=new URL(postgresUrl!);if(!parsed.pathname.includes('test'))throw Error('Test database required');
  parsed.searchParams.set('options',`-c search_path=${schema},public -c statement_timeout=10000`);
  parsed.searchParams.set('application_name',name);return parsed.toString();}
 async function seed(){const siteId=randomUUID(),owner={...ownerBase,appSlug:`mail-${siteId}`};
  await dbA.executor.insertInto('public_sites').values({id:siteId,owner_id:owner.ownerId,machine_id:owner.machineId,
   app_slug:owner.appSlug,title:'Shared invitation',description:'',slug:null,revision:1,status:'published',
   access_mode:'private_email',active_version:null,created_at:new Date().toISOString()}).execute();
  const created=await createSiteEmailInvitations(dbA,owner,{baseRevision:1,emailAddresses:['recipient@example.com']});
  return {siteId,owner,invitationId:(created.results[0] as {invitation:{id:string}}).invitation.id};}
 beforeAll(async()=>{admin=new pg.Pool({connectionString:postgresUrl,max:1});await admin.query(`CREATE SCHEMA "${schema}"`);
  dbA=createPlatformDb(url('mail-a'));await dbA.ready;dbB=createPlatformDb(url('mail-b'));await dbB.ready;
  await insertUserMachine(dbA,{machineId:ownerBase.machineId,clerkUserId:ownerBase.ownerId,handle:'site-mail-owner',
   status:'running',provisionedAt:new Date().toISOString()});});
 afterAll(async()=>{await Promise.all([dbA?.destroy(),dbB?.destroy()]);if(admin){await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await admin.end();}});

 it('commits one lease before calling the mailer and never duplicates delivery across workers',async()=>{
  const {siteId,invitationId}=await seed();
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const send=vi.fn(async(input:{url:string},_signal:AbortSignal)=>{entered.resolve();
   expect(input.url).toBe(`https://matrix.page/${siteId}`);
   await release.promise;return {kind:'sent' as const,messageId:'provider-message'};});
  const first=createSiteInvitationDeliveryWorker({db:dbA,mailer:{send}});
  const second=createSiteInvitationDeliveryWorker({db:dbB,mailer:{send}});
  const running=first.runOnce();await entered.promise;
  const leased=await dbB.executor.selectFrom('public_site_invitation_deliveries').selectAll().where('invitation_id','=',invitationId).executeTakeFirstOrThrow();
  expect(leased.state).toBe('leased');
  const invitation=await dbB.executor.selectFrom('public_site_email_invitations').select('delivery_state').where('id','=',invitationId).executeTakeFirstOrThrow();
  expect(invitation.delivery_state).toBe('sending');
  expect((await second.runOnce()).claimed).toBe(0);
  release.resolve();expect(await running).toMatchObject({claimed:1,sent:1});
  expect(send).toHaveBeenCalledOnce();
  expect((await dbB.executor.selectFrom('public_site_invitation_deliveries').selectAll().where('invitation_id','=',invitationId).executeTakeFirstOrThrow()).state).toBe('sent');
  await Promise.all([first.close(),second.close()]);
 });

 it('rejects a late provider success after the owner revokes the invitation',async()=>{
  const {siteId,invitationId,owner}=await seed();
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  const worker=createSiteInvitationDeliveryWorker({db:dbA,mailer:{send:async()=>{entered.resolve();await release.promise;return {kind:'sent' as const};}}});
  const running=worker.runOnce();await entered.promise;
  await revokeSiteEmailInvitation(dbB,owner,invitationId,{baseRevision:2,invitationRevision:0});
  release.resolve();await running;
  const row=await dbB.executor.selectFrom('public_site_invitation_deliveries').selectAll().where('invitation_id','=',invitationId).executeTakeFirstOrThrow();
  expect(row.state).toBe('cancelled');
  expect((await dbB.executor.selectFrom('public_site_email_invitations').selectAll().where('site_id','=',siteId).executeTakeFirstOrThrow()).delivery_state).not.toBe('sent');
  await worker.close();
 });

 it('expires pending invitations and removes only old terminal delivery records in bounded cleanup',async()=>{
  const expiring=await seed(),retained=await seed();
  const old=new Date(Date.now()-31*86400_000),issued=new Date(Date.now()-8*86400_000);
  await dbA.executor.updateTable('public_site_email_invitations').set({issued_at:issued,
   expires_at:new Date(issued.getTime()+7*86400_000)})
   .where('id','=',expiring.invitationId).execute();
  await dbA.executor.updateTable('public_site_invitation_deliveries').set({
   state:'sent',created_at:old,updated_at:old,available_at:old,sent_at:old,
  }).where('invitation_id','=',retained.invitationId).execute();
  const send=vi.fn();
  const worker=createSiteInvitationDeliveryWorker({db:dbA,mailer:{send}});
  expect(await worker.runOnce()).toMatchObject({claimed:0,sent:0});
  expect(send).not.toHaveBeenCalled();
  expect((await dbB.executor.selectFrom('public_site_email_invitations').select('state')
   .where('id','=',expiring.invitationId).executeTakeFirstOrThrow()).state).toBe('expired');
  expect((await dbB.executor.selectFrom('public_site_invitation_deliveries').select('state')
   .where('invitation_id','=',expiring.invitationId).executeTakeFirstOrThrow()).state).toBe('cancelled');
  expect(await dbB.executor.selectFrom('public_site_invitation_deliveries').select('id')
   .where('invitation_id','=',retained.invitationId).executeTakeFirst()).toBeUndefined();
  await worker.close();
 });

 it('suppresses a permanent provider rejection without granting access or retrying',async()=>{
  const {invitationId}=await seed();
  const send=vi.fn(async()=>({kind:'permanent' as const}));
  const worker=createSiteInvitationDeliveryWorker({db:dbA,mailer:{send}});
  expect(await worker.runOnce()).toMatchObject({claimed:1,sent:0});
  expect(await worker.runOnce()).toMatchObject({claimed:0,sent:0});
  expect(send).toHaveBeenCalledOnce();
  const invitation=await dbB.executor.selectFrom('public_site_email_invitations')
   .select(['state','delivery_state']).where('id','=',invitationId).executeTakeFirstOrThrow();
  expect(invitation).toMatchObject({state:'pending',delivery_state:'suppressed'});
  expect(await dbB.executor.selectFrom('public_site_viewer_grants').select('id')
   .where('invitation_id','=',invitationId).executeTakeFirst()).toBeUndefined();
  await worker.close();
 });
});
