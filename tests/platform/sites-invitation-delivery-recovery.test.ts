import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';
import { insertUserMachine } from '../../packages/platform/src/db.js';
import { createSiteEmailInvitations } from '../../packages/platform/src/sites/email-invitations.js';
import { createSiteInvitationDeliveryWorker } from '../../packages/platform/src/sites/invitation-delivery.js';

async function fixture() {
 const {db}=await createTestPlatformDb();
 const owner={ownerId:'user_mail_capacity',machineId:'mail-capacity-machine',appSlug:'event'};
 const siteId=randomUUID();
 await insertUserMachine(db,{machineId:owner.machineId,clerkUserId:owner.ownerId,handle:'mail-capacity',status:'running',provisionedAt:new Date().toISOString()});
 await db.executor.insertInto('public_sites').values({id:siteId,owner_id:owner.ownerId,machine_id:owner.machineId,
  app_slug:owner.appSlug,title:'Event',description:'',slug:null,revision:1,status:'published',access_mode:'private_email',active_version:null,created_at:new Date().toISOString()}).execute();
 return {db,owner,siteId};
}

it('recovers an expired fifth lease so its owner can resend',async()=>{
 const {db,siteId}=await fixture();
 const now=new Date(),invitationId=randomUUID(),deliveryId=randomUUID();
 try{
  await db.executor.insertInto('public_site_email_invitations').values({id:invitationId,site_id:siteId,
   normalized_email:'guest@example.com',display_email:'guest@example.com',generation:'1',state:'pending',delivery_state:'sending',
   invited_by_clerk_user_id:'user_mail_capacity',accepted_clerk_user_id:null,created_at:now,issued_at:now,
   expires_at:new Date(now.getTime()+86400_000),accepted_at:null,revoked_at:null,state_reason:null,updated_at:now,revision:'0'}).execute();
  await db.executor.insertInto('public_site_invitation_deliveries').values({id:deliveryId,invitation_id:invitationId,
   invitation_generation:'1',idempotency_key:randomUUID(),state:'leased',attempts:5,available_at:now,
   lease_token:randomUUID(),lease_until:new Date(now.getTime()-1000),provider_message_id:null,failure_code:null,
   sent_at:null,created_at:now,updated_at:now}).execute();
  const send=vi.fn();const worker=createSiteInvitationDeliveryWorker({db,mailer:{send}});
  try{expect(await worker.runOnce()).toEqual({claimed:0,sent:0});}finally{await worker.close();}
  expect(send).not.toHaveBeenCalled();
  expect((await db.executor.selectFrom('public_site_invitation_deliveries').select('state').where('id','=',deliveryId).executeTakeFirst())?.state).toBe('ambiguous');
  expect((await db.executor.selectFrom('public_site_email_invitations').select('delivery_state').where('id','=',invitationId).executeTakeFirst())?.delivery_state).toBe('ambiguous');
 }finally{await destroyTestPlatformDb(db);}
});

it('caps one owner\'s outstanding mail across repeated invitation requests',async()=>{
 const {db,owner,siteId}=await fixture();
 const now=new Date();
 try{
  const invitations=Array.from({length:500},(_,index)=>({id:randomUUID(),site_id:siteId,
   normalized_email:`guest${index}@example.com`,display_email:`guest${index}@example.com`,generation:'1',state:'pending' as const,
   delivery_state:'queued' as const,invited_by_clerk_user_id:owner.ownerId,accepted_clerk_user_id:null,created_at:now,
   issued_at:now,expires_at:new Date(now.getTime()+86400_000),accepted_at:null,revoked_at:null,state_reason:null,updated_at:now,revision:'0'}));
  await db.executor.insertInto('public_site_email_invitations').values(invitations).execute();
  await db.executor.insertInto('public_site_invitation_deliveries').values(invitations.map(row=>({id:randomUUID(),
   invitation_id:row.id,invitation_generation:'1',idempotency_key:randomUUID(),state:'queued' as const,attempts:0,
   available_at:now,lease_token:null,lease_until:null,provider_message_id:null,failure_code:null,sent_at:null,created_at:now,updated_at:now}))).execute();
  await expect(createSiteEmailInvitations(db,owner,{baseRevision:1,emailAddresses:['new@example.com']})).rejects.toMatchObject({code:'unavailable'});
  expect(await db.executor.selectFrom('public_site_email_invitations').select('id').where('normalized_email','=','new@example.com').executeTakeFirst()).toBeUndefined();
  await db.executor.updateTable('public_site_invitation_deliveries').set({state:'sent',sent_at:now}).where('invitation_id','=',invitations[0]!.id).execute();
  const result=await createSiteEmailInvitations(db,owner,{baseRevision:1,emailAddresses:['new@example.com']});
  expect(result.results[0]?.outcome).toBe('queued');
 }finally{await destroyTestPlatformDb(db);}
});
