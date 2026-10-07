import { Kysely, sql } from 'kysely';
import { KyselyPGlite } from 'kysely-pglite';
import { describe, expect, it } from 'vitest';
import type { PlatformDB, PlatformDatabase } from '../../packages/platform/src/db.js';
import { migratePlatformSchema } from '../../packages/platform/src/database/migrate.js';
import { bootstrapPlatformCollaborationDatabase } from '../../packages/platform/src/collaboration/database.js';
import { bootstrapPlatformOrganizationDatabase } from '../../packages/platform/src/organizations/database.js';
import { assertDeletionOwnershipSafe, eraseOwnerPlatformData } from '../../packages/platform/src/account-deletion/cleanup-data.js';

async function fixture() {
  const instance = await KyselyPGlite.create();
  const kysely = new Kysely<PlatformDatabase>({ dialect: instance.dialect });
  await migratePlatformSchema(kysely);
  await bootstrapPlatformCollaborationDatabase(kysely as never);
  await bootstrapPlatformOrganizationDatabase(kysely as never);
  const wrap = (executor: PlatformDB['executor']): PlatformDB => ({ kysely, executor, ready: Promise.resolve(),
    transaction: (fn) => kysely.transaction().execute((trx) => fn(wrap(trx))), destroy: () => kysely.destroy() });
  return wrap(kysely);
}
describe('account deletion personal database cleanup', () => {
  it('supports an owner with no billing or VPS and is idempotent', async () => {
    const db = await fixture();
    try {
      await expect(assertDeletionOwnershipSafe(db, 'user_empty')).resolves.toBeUndefined();
      await expect(eraseOwnerPlatformData(db, 'user_empty')).resolves.toBeUndefined();
      await expect(eraseOwnerPlatformData(db, 'user_empty')).resolves.toBeUndefined();
    } finally { await db.destroy(); }
  });
  it('blocks destruction of owner-hosted shared resources while retaining their data', async () => {
    const db = await fixture();
    try {
      await sql`INSERT INTO collaboration_directory (scope_id,runtime_id,owner_id,kind,authority_generation,metadata_revision,last_event_id,audience)
        VALUES ('11111111-1111-4111-8111-111111111111','machine','user_owner','project',1,1,'22222222-2222-4222-8222-222222222222','members')`.execute(db.executor);
      await expect(assertDeletionOwnershipSafe(db, 'user_owner')).rejects.toThrow('ownership_transfer_required');
      await expect(eraseOwnerPlatformData(db, 'user_owner')).rejects.toThrow('ownership_transfer_required');
      expect((await db.executor.selectFrom('users').selectAll().execute()).length).toBe(0);
      expect((await sql`SELECT * FROM collaboration_directory`.execute(db.executor)).rows.length).toBe(1);
    } finally { await db.destroy(); }
  });
  it.each(['machine','vps:machine'])('retains transferred shared data still hosted on runtime %s',async(runtimeId)=> {
    const db=await fixture();
    try {
      await sql`INSERT INTO user_machines (machine_id,clerk_user_id,handle,status,deleted_at,provisioned_at)
        VALUES ('machine','user_owner','owner','deleted','2026-10-01','2026-10-01')`.execute(db.executor);
      await sql`INSERT INTO collaboration_directory (scope_id,runtime_id,owner_id,kind,authority_generation,metadata_revision,last_event_id,audience)
        VALUES ('11111111-1111-4111-8111-111111111111',${runtimeId},'user_transferred','project',1,1,'22222222-2222-4222-8222-222222222222','members')`.execute(db.executor);
      await expect(assertDeletionOwnershipSafe(db,'user_owner')).rejects.toThrow('ownership_transfer_required');
      await expect(eraseOwnerPlatformData(db,'user_owner')).rejects.toThrow('ownership_transfer_required');
      expect((await sql`SELECT * FROM collaboration_directory`.execute(db.executor)).rows).toHaveLength(1);
      expect((await db.executor.selectFrom('user_machines').selectAll().execute())).toHaveLength(1);
    } finally {await db.destroy();}
  });
  it('erases personal identities and content and decrements surviving social counts atomically', async () => {
    const db = await fixture();
    try {
      await sql`INSERT INTO users (id,clerk_id,handle,display_name,email,container_id)
        VALUES ('33333333-3333-4333-8333-333333333333','user_owner','owner','Owner','owner@example.test','platform:user_owner')`.execute(db.executor);
      await sql`INSERT INTO social_posts (id,author_id,content,type,likes_count,comments_count,created_at)
        VALUES ('other','user_other','retained','text',1,1,'2026-10-01')`.execute(db.executor);
      await sql`INSERT INTO social_likes (post_id,user_id,created_at) VALUES ('other','user_owner','2026-10-01')`.execute(db.executor);
      await sql`INSERT INTO social_comments (id,post_id,author_id,content,created_at)
        VALUES ('mine','other','user_owner','removed','2026-10-01')`.execute(db.executor);
      await eraseOwnerPlatformData(db,'user_owner');
      expect(await db.executor.selectFrom('users').selectAll().execute()).toEqual([]);
      expect(await db.executor.selectFrom('social_posts').select(['content','likes_count','comments_count']).execute())
        .toEqual([{ content: 'retained', likes_count: 0, comments_count: 0 }]);
    } finally { await db.destroy(); }
  });
});

import { vi } from 'vitest';
import { createAccountDeletionAdapters } from '../../packages/platform/src/account-deletion/adapters.js';
const ctx = { clerkUserId:'user_owner',appleTokens:[] };
describe('production cleanup adapters', () => {
  it.each([false,true])('retains Custom MCP credentials when cleanup is unavailable (runtime=%s)',async(liveRuntime)=> {
    const db=await fixture();
    try {
      const userId='11111111-1111-4111-8111-111111111111';
      await sql`INSERT INTO users (id,clerk_id,handle,display_name,email,container_id)
        VALUES (${userId},'user_owner','owner','Owner','owner@example.test','owner')`.execute(db.executor);
      await sql`CREATE TABLE custom_mcp_servers (id TEXT PRIMARY KEY,user_id UUID REFERENCES users(id) ON DELETE CASCADE,encrypted_credentials TEXT)`.execute(db.executor);
      await sql`INSERT INTO custom_mcp_servers VALUES ('owner_grant',${userId},'encrypted_grant')`.execute(db.executor);
      if(liveRuntime) await sql`INSERT INTO user_machines (machine_id,clerk_user_id,handle,status,provisioned_at)
        VALUES ('machine','user_owner','owner','running','2026-10-01')`.execute(db.executor);
      const remove=vi.fn();
      const adapters=createAccountDeletionAdapters({db,clerkSecretKey:'key',r2PrefixRoot:'sync',
        customMcp:liveRuntime?{remove}:undefined});
      await expect(adapters.integrations(ctx)).rejects.toThrow(liveRuntime?'Integration runtime cleanup pending':'Integration cleanup configuration unavailable');
      expect(remove).not.toHaveBeenCalled();
      expect((await sql`SELECT encrypted_credentials FROM custom_mcp_servers`.execute(db.executor)).rows)
        .toEqual([{encrypted_credentials:'encrypted_grant'}]);
    }finally{await db.destroy();}
  });
  it('expires an unpaid open checkout rather than ignoring owners without a customer/VPS', async()=> {
    const db=await fixture();
    try {
      await sql`INSERT INTO billing_checkout_attempts (id,clerk_user_id,stripe_session_id,runtime_slot,status,created_at)
        VALUES ('attempt','user_owner','cs_test_open','primary','open','2026-10-01')`.execute(db.executor);
      const calls: Array<{url:string;method?:string}> = [];
      const request=vi.fn(async (url:string|URL|Request,init?:RequestInit)=> {
        calls.push({url:String(url),method:init?.method});
        return Response.json({status:'open'});
      });
      await createAccountDeletionAdapters({db,clerkSecretKey:'key',r2PrefixRoot:'matrixos-sync',stripeSecretKey:'stripe',fetch:request}).billing(ctx);
      expect(calls).toEqual([{url:'https://api.stripe.com/v1/checkout/sessions/cs_test_open',method:'GET'},
        {url:'https://api.stripe.com/v1/checkout/sessions/cs_test_open/expire',method:'POST'}]);
    } finally {await db.destroy();}
  });
  it('cancels every live Stripe subscription, including slots absent from local projection, without refunds', async()=> {
    const db=await fixture();
    try {
      await sql`INSERT INTO billing_customers (clerk_user_id,stripe_customer_id,created_at,updated_at)
        VALUES ('user_owner','cus_a','2026-10-01','2026-10-01')`.execute(db.executor);
      const cancellations: RequestInit[]=[];
      const request=vi.fn(async (url:string|URL|Request,init?:RequestInit)=> {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        if(String(url).includes('/subscriptions?')) return Response.json({data:[{id:'sub_a',status:'active'},{id:'sub_b',status:'trialing'}],has_more:false});
        if(init?.method==='DELETE') cancellations.push(init);
        return Response.json({status:init?.method==='DELETE'?'canceled':'active'});
      });
      await createAccountDeletionAdapters({db,clerkSecretKey:'key',r2PrefixRoot:'matrixos-sync',stripeSecretKey:'stripe',fetch:request}).billing(ctx);
      expect(cancellations).toHaveLength(2);
      expect(cancellations.map((call)=>String(call.body))).toEqual(['invoice_now=false&prorate=false','invoice_now=false&prorate=false']);
    } finally {await db.destroy();}
  });
  it.each(['active','canceled'])('projects confirmed provider cancellation for an existing %s subscription',async(remoteStatus)=> {
    const db=await fixture();
    try {
      await sql`INSERT INTO billing_subscriptions (stripe_subscription_id,clerk_user_id,stripe_customer_id,runtime_slot,plan_slug,stripe_price_id,billing_interval,status,latest_event_created_at,latest_event_id,updated_at)
        VALUES ('sub_project','user_owner','cus_project','primary','matrix_starter','price_project','monthly','active','2026-10-01','evt_old','2026-10-01')`.execute(db.executor);
      await sql`INSERT INTO billing_entitlements (clerk_user_id,source,plan_slug,status,max_runtime_slots,included_runtime_slots,addon_runtime_slots,default_server_type,allowed_server_types,stripe_subscription_id,effective_from,updated_at)
        VALUES ('user_owner','stripe','matrix_starter','active',1,1,0,'cpx22','["cpx22"]','sub_project','2026-10-01','2026-10-01')`.execute(db.executor);
      const request=vi.fn(async(url:string|URL|Request,init?:RequestInit)=>String(url).includes('/subscriptions?')
        ? Response.json({data:[{id:'sub_project',status:remoteStatus}],has_more:false})
        : Response.json({status:init?.method==='DELETE'?'canceled':remoteStatus}));
      await createAccountDeletionAdapters({db,clerkSecretKey:'key',r2PrefixRoot:'sync',stripeSecretKey:'stripe',fetch:request}).billing(ctx);
      expect((await db.executor.selectFrom('billing_subscriptions').select('status').execute())[0]?.status).toBe('canceled');
      expect((await db.executor.selectFrom('billing_entitlements').select(['status','effective_until']).execute())[0])
        .toMatchObject({status:'canceled',effective_until:expect.any(String)});
    } finally {await db.destroy();}
  });
  it('clears a stale Stripe entitlement after confirming there are no provider resources',async()=> {
    const db=await fixture();
    try {
      await sql`INSERT INTO billing_entitlements (clerk_user_id,source,plan_slug,status,max_runtime_slots,included_runtime_slots,addon_runtime_slots,default_server_type,allowed_server_types,effective_from,updated_at)
        VALUES ('user_owner','stripe','matrix_starter','active',1,1,0,'cpx22','["cpx22"]','2026-10-01','2026-10-01')`.execute(db.executor);
      const request=vi.fn();
      await createAccountDeletionAdapters({db,clerkSecretKey:'key',r2PrefixRoot:'sync',fetch:request}).billing(ctx);
      expect(request).not.toHaveBeenCalled();
      expect((await db.executor.selectFrom('billing_entitlements').select('status').execute())[0]?.status).toBe('canceled');
    } finally {await db.destroy();}
  });
  it('does not declare runtime destruction while a queued provider server still exists', async()=> {
    const db=await fixture();
    try {
      await sql`INSERT INTO user_machines (machine_id,clerk_user_id,handle,status,deleted_at,provisioned_at)
        VALUES ('machine','user_owner','owner','deleted','2026-10-01','2026-10-01')`.execute(db.executor);
      await sql`INSERT INTO provider_deletion_queue (id,provider_server_id,reason,machine_id,attempts,next_attempt_at,created_at)
        VALUES ('queued',99,'delete','machine',0,'2026-10-01','2026-10-01')`.execute(db.executor);
      const deleteServer=vi.fn(async()=>undefined);
      const adapters=createAccountDeletionAdapters({db,clerkSecretKey:'key',r2PrefixRoot:'matrixos-sync',fetch:async()=>Response.json({data:[],total_count:0}),customerVpsService:{delete:vi.fn()},
        hetzner:{listServersByLabel:async()=>[],getServer:async()=>({id:99,status:'running'}),deleteServer}});
      await expect(adapters.vps(ctx)).rejects.toThrow('Runtime cleanup pending');
      expect(deleteServer).toHaveBeenCalledWith(99);
      expect((await db.executor.selectFrom('provider_deletion_queue').select('completed_at').execute())[0]?.completed_at).toBeNull();
    } finally {await db.destroy();}
  });
  it('retains an ambiguous recovery create without discarding intent or declaring an empty inventory complete',async()=> {
    const db=await fixture();
    try {
      await sql`INSERT INTO user_machines (machine_id,clerk_user_id,handle,status,recovery_encrypted_payload,provisioned_at)
        VALUES ('machine','user_owner','owner','recovering','pending-provider-secret','2026-10-01')`.execute(db.executor);
      const destroy=vi.fn();
      const adapters=createAccountDeletionAdapters({db,clerkSecretKey:'key',r2PrefixRoot:'sync',
        fetch:async()=>Response.json({data:[],total_count:0}),customerVpsService:{delete:destroy},
        hetzner:{listServersByLabel:async()=>[],getServer:async()=>null,deleteServer:vi.fn()}});
      await expect(adapters.vps(ctx)).rejects.toThrow('Runtime provider create reconciliation required');
      expect(destroy).not.toHaveBeenCalled();
      expect((await db.executor.selectFrom('user_machines').select('recovery_encrypted_payload').execute())[0]?.recovery_encrypted_payload)
        .toBe('pending-provider-secret');
    } finally {await db.destroy();}
  });
  it('waits for the longest signed upload lifetime after stopping the runtime',async()=> {
    const db=await fixture();
    try {
      await sql`INSERT INTO user_machines (machine_id,clerk_user_id,handle,status,deleted_at,provisioned_at)
        VALUES ('machine','user_owner','owner','deleted',${new Date().toISOString()},'2026-10-01')`.execute(db.executor);
      const listObjects=vi.fn(async()=>({keys:[],nextCursor:null}));
      const adapters=createAccountDeletionAdapters({db,clerkSecretKey:'key',r2PrefixRoot:'matrixos-sync',
        objectStore:{listObjects,deleteObject:vi.fn(),abortOwnerMultipartUploads:vi.fn()}});
      await expect(adapters.storage(ctx)).rejects.toThrow('Storage upload expiration pending');
      expect(listObjects).not.toHaveBeenCalled();
    } finally {await db.destroy();}
  });
});

describe('cleanup fail closed and resume',()=> {
  it('continues deletion with manual Apple revocation after an upstream identity deletion',async()=> {
    const db=await fixture();
    try {
      const adapters=createAccountDeletionAdapters({db,clerkSecretKey:'key',r2PrefixRoot:'matrixos-sync',fetch:async()=>new Response(null,{status:404})});
      const context=await adapters.prepare('user_owner',true);
      expect(context.appleRevocationUnknown).toBe(true);
      expect(context.manualAppleRevocationRequired).toBe(true);
      const prepared = await adapters.prepareAppleRevocation!(context);
      await expect(adapters.apple(prepared)).resolves.toBeUndefined();
    } finally {await db.destroy();}
  });
  it('preserves unsettled response billing rather than deleting reconciliation evidence',async()=> {
    const db=await fixture();
    try {
      await sql`INSERT INTO user_machines (machine_id,clerk_user_id,handle,provisioned_at)
        VALUES ('machine','user_owner','owner','2026-10-01')`.execute(db.executor);
      await sql`INSERT INTO ai_runtime_credentials (token_id,token_hash,owner_id,machine_id,runtime_slot,audience,scope,issued_at,expires_at)
        VALUES ('token',${'b'.repeat(64)},'user_owner','machine','primary','matrix-funded-relay','ai:invoke','2026-10-01','2026-11-01')`.execute(db.executor);
      await sql`INSERT INTO ai_funded_usage_reservations
        (reservation_id,request_id,payload_hash,authorization_response,token_id,owner_id,machine_id,runtime_slot,model_id,reserved_microusd,period_start,status,created_at,expires_at)
        VALUES ('reserve','request',${'a'.repeat(64)},'{}','token','user_owner','machine','primary','model',1,'2026-10-01','in_flight','2026-10-01','2026-11-01')`.execute(db.executor);
      await expect(eraseOwnerPlatformData(db,'user_owner')).rejects.toThrow('accounting_reconciliation_required');
      expect((await db.executor.selectFrom('ai_funded_usage_reservations').select('status').execute())[0]?.status).toBe('in_flight');
    } finally {await db.destroy();}
  });
});

describe('anonymous accounting tombstone',()=> {
  it('keeps amount totals while erasing account keys, provider identifiers and runtime credentials',async()=> {
    const db=await fixture();
    try {
      await sql`INSERT INTO account_deletion_jobs (owner_hash,status,due_at,next_attempt_at,created_at,updated_at)
        VALUES ('opaque-owner-hash','processing','2026-10-01','2026-10-01','2026-10-01','2026-10-01')`.execute(db.executor);
      await sql`INSERT INTO user_machines (machine_id,clerk_user_id,handle,status,deleted_at,provisioned_at)
        VALUES ('machine','user_owner','owner','deleted','2026-10-01','2026-10-01')`.execute(db.executor);
      await sql`INSERT INTO ai_runtime_credentials (token_id,token_hash,owner_id,machine_id,runtime_slot,audience,scope,issued_at,expires_at)
        VALUES ('token',${'c'.repeat(64)},'user_owner','machine','primary','matrix-funded-relay','ai:invoke','2026-10-01','2026-11-01')`.execute(db.executor);
      await sql`INSERT INTO ai_funded_usage_reservations
        (reservation_id,request_id,payload_hash,authorization_response,token_id,owner_id,machine_id,runtime_slot,model_id,reserved_microusd,period_start,status,created_at,expires_at)
        VALUES ('reserve','request',${'d'.repeat(64)},'{}','token','user_owner','machine','primary','model',2,'2026-10-01','settled','2026-10-01','2026-11-01')`.execute(db.executor);
      await sql`INSERT INTO ai_funded_credit_ledger (entry_id,owner_id,machine_id,runtime_slot,kind,amount_microusd,source_reference,reservation_id,period_start,created_at)
        VALUES ('grant','user_owner','machine','primary','addon_grant',5,'pi_sensitive',NULL,NULL,'2026-10-01'),
          ('debit','user_owner','machine','primary','addon_debit',-2,'req_sensitive','reserve','2026-10-01','2026-10-01')`.execute(db.executor);
      await eraseOwnerPlatformData(db,'user_owner',()=> 'opaque-owner-hash');
      const summary = await sql<{accounting_summary: unknown}>`SELECT accounting_summary FROM account_deletion_jobs`.execute(db.executor);
      expect(summary.rows[0]?.accounting_summary).toEqual({addon_grant:{entryCount:1,amountMicrousd:5},addon_debit:{entryCount:1,amountMicrousd:-2}});
      expect(await db.executor.selectFrom('ai_funded_credit_ledger').selectAll().execute()).toEqual([]);
      expect(await db.executor.selectFrom('ai_runtime_credentials').selectAll().execute()).toEqual([]);
      expect(await db.executor.selectFrom('user_machines').selectAll().execute()).toEqual([]);
      expect(await db.executor.selectFrom('ai_funded_usage_reservations').selectAll().execute()).toEqual([]);
    } finally {await db.destroy();}
  });
});

describe('Matrix integration credential revocation',()=> {
  it('fails closed with persisted remote tokens and no homeserver configuration',async()=> {
    const db=await fixture();
    try {
      await sql`INSERT INTO user_machines (machine_id,clerk_user_id,handle,status,deleted_at,provisioned_at)
        VALUES ('machine','user_owner','owner','deleted','2026-10-01','2026-10-01')`.execute(db.executor);
      await sql`INSERT INTO matrix_users (handle,human_matrix_id,ai_matrix_id,human_access_token,ai_access_token,created_at)
        VALUES ('owner','@owner:matrix-os.com','@owner-ai:matrix-os.com','human-token','ai-token','2026-10-01')`.execute(db.executor);
      await expect(createAccountDeletionAdapters({db,clerkSecretKey:'key',r2PrefixRoot:'matrixos-sync'}).integrations(ctx))
        .rejects.toThrow('Matrix credential cleanup configuration unavailable');
    }finally{await db.destroy();}
  });
  it('revokes both Matrix sessions and accepts only proven already-invalid tokens on retry',async()=> {
    const db=await fixture();
    try {
      await sql`INSERT INTO user_machines (machine_id,clerk_user_id,handle,status,deleted_at,provisioned_at)
        VALUES ('machine','user_owner','owner','deleted','2026-10-01','2026-10-01')`.execute(db.executor);
      await sql`INSERT INTO matrix_users (handle,human_matrix_id,ai_matrix_id,human_access_token,ai_access_token,created_at)
        VALUES ('owner','@owner:matrix-os.com','@owner-ai:matrix-os.com','human-token','ai-token','2026-10-01')`.execute(db.executor);
      const request=vi.fn(async (_url:string|URL|Request,init?:RequestInit)=> {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return Response.json({errcode:'M_UNKNOWN_TOKEN'},{status:401});
      });
      await createAccountDeletionAdapters({db,clerkSecretKey:'key',r2PrefixRoot:'matrixos-sync',matrixHomeserverUrl:'https://matrix.example.test',fetch:request}).integrations(ctx);
      expect(request.mock.calls).toHaveLength(2);
      expect(request.mock.calls.map((call)=>call[0])).toEqual(['https://matrix.example.test/_matrix/client/v3/logout/all','https://matrix.example.test/_matrix/client/v3/logout/all']);
    }finally{await db.destroy();}
  });
});
import { migrateAts } from '../../packages/platform/src/ats-schema.js';
describe('shared recruiting data boundary',()=> {
  it('removes staff assignment and anonymizes authors while retaining shared candidate content',async()=> {
    const db=await fixture();
    try {
      await migrateAts(db.kysely as never);
      await sql`INSERT INTO ats_applications (id,submission_key,role_slug,candidate_name,candidate_email,location,availability,
        owner_id,consent_at,retention_until,resume_filename,resume_content_type,resume_bytes,created_at,updated_at)
        VALUES ('candidate','submission','engineer','Candidate','candidate@example.test','Anywhere','Now','user_owner',
          '2026-10-01','2027-10-01','resume.txt','text/plain',${Buffer.from('resume')},'2026-10-01','2026-10-01')`.execute(db.executor);
      await sql`INSERT INTO ats_notes (id,application_id,author_id,body,created_at,updated_at)
        VALUES ('note','candidate','user_owner','Shared recruiting note','2026-10-01','2026-10-01')`.execute(db.executor);
      await eraseOwnerPlatformData(db,'user_owner');
      expect((await sql<{owner_id:string|null;candidate_email:string}>`SELECT owner_id,candidate_email FROM ats_applications`.execute(db.executor)).rows)
        .toEqual([{owner_id:null,candidate_email:'candidate@example.test'}]);
      const note=(await sql<{author_id:string;body:string}>`SELECT author_id,body FROM ats_notes`.execute(db.executor)).rows[0]!;
      expect(note.author_id).toMatch(/^deleted:/);
      expect(note.body).toBe('Shared recruiting note');
    }finally{await db.destroy();}
  });
});
describe('live organization ownership recheck',()=> {
  it('blocks destructive phases if a user becomes sole admin during grace despite an empty projection',async()=> {
    const db=await fixture();
    try {
      const request=vi.fn(async (url:string|URL|Request)=> String(url).includes('/users/')
        ? Response.json({data:[{role:'org:admin',organization:{id:'org_a'}}],total_count:1})
        : Response.json({data:[{role:'org:admin',public_user_data:{user_id:'user_owner'}}],total_count:1}));
      const adapters=createAccountDeletionAdapters({db,clerkSecretKey:'key',r2PrefixRoot:'matrixos-sync',fetch:request});
      await expect(adapters.vps(ctx)).rejects.toThrow('ownership_transfer_required');
      await expect(adapters.clerk(ctx)).rejects.toThrow('ownership_transfer_required');
      expect(request.mock.calls).toHaveLength(4);
    }finally{await db.destroy();}
  });
});
