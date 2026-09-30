import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type Kysely, type KyselyPlugin } from "kysely";
import { createCollaborationTestDatabase, createRealCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";
import { bootstrapSlackCompanyDatabase, type SlackCompanyDatabase } from "../../packages/gateway/src/slack/database.js";
import { SlackCompanyRepository, eventKey, threadKey } from "../../packages/gateway/src/slack/repository.js";
import { bootstrapSlackPersonalDatabase, SlackPersonalRepository, personalDmKey, type SlackPersonalDatabase, personalEventId as rowId } from "../../packages/gateway/src/slack/personal-database.js";
import type { SlackHomeEnvelope, SlackThreadBinding } from "../../packages/gateway/src/slack/schemas.js";

const envelope: SlackHomeEnvelope = {ownerId:"user_owner",actorId:"user_owner",organizationId:"org_team",channelScopeId:"10000000-0000-4000-8000-000000000001",
  event:{appId:"A123",teamId:"T123",userId:"U123",channelId:"C123",eventId:"Ev123",ts:"1790766000.000001",text:"Decision evidence",kind:"mention"}};
const direct = {...envelope,channelScopeId:undefined,event:{...envelope.event,channelId:"D123",kind:"direct_message" as const}};
const thread: SlackThreadBinding = {scopeId:"10000000-0000-4000-8000-000000000002",projectScopeId:envelope.channelScopeId!,projectId:"project_company",chatId:"chat_company"};
const personal = {chatId:"chat_personal",botId:"bot_aaaaaaaa"};
type Database = SlackCompanyDatabase & SlackPersonalDatabase;

describe("Slack repository lease, capacity and persistence boundaries",()=>{
  let fixture:CollaborationTestDatabase, db:Kysely<Database>, company:SlackCompanyRepository, privateInbox:SlackPersonalRepository;
  let now:Date;
  let companyDb:Kysely<SlackCompanyDatabase>,personalDb:Kysely<SlackPersonalDatabase>;
  beforeEach(async()=>{
    now=new Date("2026-09-30T11:00:00Z");
    fixture=await (process.env.MATRIX_TEST_POSTGRES_URL?createRealCollaborationTestDatabase():createCollaborationTestDatabase());
    db=fixture.db as unknown as Kysely<Database>;
    companyDb=db as unknown as Kysely<SlackCompanyDatabase>;personalDb=db as unknown as Kysely<SlackPersonalDatabase>;
    await bootstrapSlackCompanyDatabase(companyDb);await bootstrapSlackPersonalDatabase(personalDb);
    company=new SlackCompanyRepository(companyDb,envelope.ownerId,()=>now);privateInbox=new SlackPersonalRepository(personalDb,envelope.ownerId,()=>now);
  });
  afterEach(async()=>fixture.destroy());
  const advance=(ms:number)=>{now=new Date(now.getTime()+ms);};
  async function companyBound(){await company.receive(envelope);const row=(await company.claim())!;return company.bind(row,envelope,thread,"Pinned text","0",[],"not_requested");}
  async function personalBound(){await privateInbox.receive(direct);const row=(await privateInbox.claim())!;return privateInbox.bind(row,async()=>personal);}

  it("preserves pinned company input and rejects stale leases or switched thread bindings",async()=>{
    const row=await companyBound();
    await expect(company.bind({...row,lease:"20000000-0000-4000-8000-000000000001"},envelope,thread,"replace","1",[],"captured")).rejects.toMatchObject({code:"conflict"});
    await expect(company.bind(row,envelope,{...thread,chatId:"chat_other"},"replace","1",[],"captured")).rejects.toMatchObject({code:"conflict"});
    const replay=await company.bind(row,envelope,thread,"replace","1",[],"captured");expect(replay.request_text).toBe("Pinned text");expect(replay.ingestion_status).toBe("not_requested");
    await db.updateTable("slack_company_threads").set({owner_id:"user_other"}).execute();
    await expect(company.bind(row,envelope,thread,"replace","1",[],"captured")).rejects.toMatchObject({code:"forbidden"});
  });
  it("rejects company event identity reuse across owners or changed payloads",async()=>{
    await company.receive(envelope);
    expect(await company.receive(envelope)).toMatchObject({duplicate:true});
    await expect(company.receive({...envelope,event:{...envelope.event,text:"Changed"}})).rejects.toMatchObject({code:"conflict"});
    await expect(new SlackCompanyRepository(companyDb,"user_other",()=>now).receive(envelope)).rejects.toMatchObject({code:"conflict"});
  });
  it("backs off company retries and settles only an exact live send lease",async()=>{
    await company.receive(envelope);const row=(await company.claim())!;await company.release(row,true);expect(await company.claim()).toBeNull();advance(10_001);
    const retry=(await company.claim())!;await company.release(retry,false);expect((await db.selectFrom("slack_company_inbox").select("state").executeTakeFirstOrThrow()).state).toBe("failed");
    const other={...envelope,event:{...envelope.event,eventId:"EvOther"}};await company.receive(other);const next=(await company.claim())!;await company.accepted(next,"qturn_other");
    const accepted=(await company.waiting())[0];await company.deferResult(accepted);await company.finish(accepted,{runId:"run_other",text:"Answer"});const send=(await company.claimReply())!;
    await company.replyStatus(send.outbox.event_id,send.outbox.lease,"pending");expect(await company.claimReply()).toBeNull();advance(30_001);const second=(await company.claimReply())!;
    await company.replyStatus(second.outbox.event_id,second.outbox.lease,"sent","1790766001.000001");expect(await company.claimReply()).toBeNull();
  });
  it("reaps exhausted expired company claims without changing another owner's active receipt",async()=>{
    await company.receive(envelope);const own=(await company.claim())!;
    const otherEnvelope={...envelope,ownerId:"user_other",actorId:"user_other",event:{...envelope.event,eventId:"EvForeign"}};
    const foreign=new SlackCompanyRepository(companyDb,"user_other",()=>now);await foreign.receive(otherEnvelope);const other=(await foreign.claim())!;
    await db.updateTable("slack_company_inbox").set({attempts:8}).execute();advance(61_000);
    expect(await company.claim()).toBeNull();
    expect(await db.selectFrom("slack_company_inbox").select(["state","lease","lease_until"]).where("id","=",own.id).executeTakeFirstOrThrow()).toEqual({state:"failed",lease:null,lease_until:null});
    expect(await db.selectFrom("slack_company_inbox").select(["state","lease"]).where("id","=",other.id).executeTakeFirstOrThrow()).toEqual({state:"processing",lease:other.lease});
    expect(await foreign.claim()).toBeNull();expect((await db.selectFrom("slack_company_inbox").select("state").where("id","=",other.id).executeTakeFirstOrThrow()).state).toBe("failed");
  });
  it("caps pending and retained company events without deleting accepted work",async()=>{
    await company.receive(envelope);
    await sql`INSERT INTO slack_company_inbox(id,owner_id,envelope,payload_hash,state,attempts,lease,lease_until,chat_id,scope_id,request_text,expected_revision,queued_turn_id,source_proofs,ingestion_status,created_at,updated_at) SELECT md5(i::text)::uuid,owner_id,envelope,payload_hash,state,attempts,lease,lease_until,chat_id,scope_id,request_text,expected_revision,queued_turn_id,source_proofs,ingestion_status,created_at,updated_at FROM slack_company_inbox CROSS JOIN generate_series(1,999) AS i`.execute(db);
    await expect(company.receive({...envelope,event:{...envelope.event,eventId:"EvCapacity"}})).rejects.toMatchObject({code:"capacity"});
    await db.updateTable("slack_company_inbox").set({state:"failed"}).execute();
    await sql`INSERT INTO slack_company_inbox(id,owner_id,envelope,payload_hash,state,attempts,lease,lease_until,chat_id,scope_id,request_text,expected_revision,queued_turn_id,source_proofs,ingestion_status,created_at,updated_at) SELECT md5(i::text)::uuid,owner_id,envelope,payload_hash,state,attempts,lease,lease_until,chat_id,scope_id,request_text,expected_revision,queued_turn_id,source_proofs,ingestion_status,created_at,updated_at FROM slack_company_inbox CROSS JOIN generate_series(1000,9999) AS i WHERE id=${eventKey(envelope)}::uuid`.execute(db);
    await expect(company.receive({...envelope,event:{...envelope.event,eventId:"EvRetained"}})).rejects.toMatchObject({code:"capacity"});
  });
  it("caps new company thread mappings and keeps the existing mapping usable",async()=>{
    const row=await companyBound();
    await sql`INSERT INTO slack_company_threads(thread_key,owner_id,organization_id,project_scope_id,project_id,chat_id,scope_id,updated_at) SELECT md5(i::text),owner_id,organization_id,project_scope_id,project_id,chat_id,scope_id,updated_at FROM slack_company_threads CROSS JOIN generate_series(1,9999) AS i`.execute(db);
    expect((await company.bind(row,envelope,thread,"retry","1",[],"captured")).chat_id).toBe(thread.chatId);
    const other={...envelope,event:{...envelope.event,eventId:"EvOther",ts:"1790766002.000001"}};await company.receive(other);const claim=(await company.claim())!;
    await expect(company.bind(claim,other,thread,"new","0",[],"not_requested")).rejects.toMatchObject({code:"capacity"});
  });
  it("fences company acceptance and completion by lease/request identity",async()=>{
    const row=await companyBound();await company.accepted({...row,lease:null},"qturn_stale");
    expect((await db.selectFrom("slack_company_inbox").select("state").executeTakeFirstOrThrow()).state).toBe("processing");
    await company.refreshRevision(row,"2");await company.accepted(row,"qturn_actual");
    const accepted=(await company.waiting())[0];await company.finish({...accepted,queued_turn_id:"qturn_other"},{runId:"run_other",text:"Unrelated"});expect(await db.selectFrom("slack_company_outbox").selectAll().execute()).toHaveLength(0);
    await company.finish(accepted,null);expect((await db.selectFrom("slack_company_inbox").select("state").executeTakeFirstOrThrow()).state).toBe("failed");
    await company.finish(accepted,{runId:"run_late",text:"Late"});expect(await db.selectFrom("slack_company_outbox").selectAll().execute()).toHaveLength(0);
  });
  it("keeps uncertain company sends unreplayed and fences stale settlement",async()=>{
    const row=await companyBound();await company.accepted(row,"qturn_actual");await company.finish((await company.waiting())[0],{runId:"run_actual",text:"Answer"});
    expect(await company.publicationReceipt("A123","T123","Ev123")).toBeNull();
    const sending=(await company.claimReply())!;await company.replyStatus(sending.outbox.event_id,null,"sent","1790766001.000001");
    expect((await db.selectFrom("slack_company_outbox").select("state").executeTakeFirstOrThrow()).state).toBe("sending");
    expect(await company.publicationReceipt("A123","T123","Ev123")).not.toBeNull();advance(31_000);expect(await company.publicationReceipt("A123","T123","Ev123")).toBeNull();
    expect(await company.claimReply()).toBeNull();expect((await db.selectFrom("slack_company_outbox").select("state").executeTakeFirstOrThrow()).state).toBe("uncertain");
    expect(await company.publicationReceipt("A123","T123","EvMissing")).toBeNull();
  });
  it("recovers only this owner's expired company sends without altering another owner's lease",async()=>{
    const own=await companyBound();await company.accepted(own,"qturn_actual");
    await company.finish((await company.waiting())[0],{runId:"run_actual",text:"Owner answer"});await company.claimReply();
    const otherEnvelope={...envelope,ownerId:"user_other",actorId:"user_other",event:{...envelope.event,eventId:"EvOther",channelId:"C999"}};
    const other=new SlackCompanyRepository(companyDb,otherEnvelope.ownerId,()=>now);
    await other.receive(otherEnvelope);const claimed=(await other.claim())!;
    const bound=await other.bind(claimed,otherEnvelope,{...thread,chatId:"chat_other",scopeId:"10000000-0000-4000-8000-000000000003"},"Other input","0",[],"not_requested");
    await other.accepted(bound,"qturn_other");await other.finish((await other.waiting())[0],{runId:"run_other",text:"Other answer"});
    const foreign=(await other.claimReply())!;advance(31_000);
    expect(await company.claimReply()).toBeNull();
    expect((await db.selectFrom("slack_company_outbox").select("state").where("event_id","=",own.id).executeTakeFirstOrThrow()).state).toBe("uncertain");
    expect(await db.selectFrom("slack_company_outbox").selectAll().where("event_id","=",foreign.outbox.event_id).executeTakeFirstOrThrow()).toEqual(foreign.outbox);
    expect(await other.claimReply()).toBeNull();
    expect((await db.selectFrom("slack_company_outbox").select("state").where("event_id","=",foreign.outbox.event_id).executeTakeFirstOrThrow()).state).toBe("uncertain");
  });
  it("expires abandoned company work and drops inactive mappings after retention",async()=>{
    await companyBound();advance(2*86400_000);await company.cleanup();expect((await db.selectFrom("slack_company_inbox").select("state").executeTakeFirstOrThrow()).state).toBe("failed");
    advance(31*86400_000);await company.cleanup();expect(await db.selectFrom("slack_company_inbox").selectAll().execute()).toHaveLength(0);expect(await db.selectFrom("slack_company_threads").selectAll().execute()).toHaveLength(0);
    expect(await company.claim()).toBeNull();
  });

  it("rejects personal stale leases, foreign mappings and invalid recipe identifiers",async()=>{
    await privateInbox.receive(direct);const row=(await privateInbox.claim())!;
    await expect(privateInbox.bind({...row,lease:null},async()=>personal)).rejects.toMatchObject({code:"conflict"});
    for(const binding of [{...personal,chatId:"unsafe/path"},{...personal,botId:"unsafe"}]) await expect(privateInbox.bind(row,async()=>binding)).rejects.toMatchObject({code:"forbidden"});
    await db.insertInto("slack_personal_conversations").values({dm_key:personalDmKey(direct),owner_id:"user_other",chat_id:personal.chatId,bot_id:personal.botId,updated_at:now}).execute();
    await expect(privateInbox.bind(row,async()=>personal)).rejects.toMatchObject({code:"forbidden"});
    await db.updateTable("slack_personal_conversations").set({owner_id:envelope.ownerId}).execute();await db.updateTable("slack_personal_inbox").set({chat_id:"chat_changed"}).execute();
    await expect(privateInbox.bind(row,async()=>personal)).rejects.toMatchObject({code:"conflict"});
  });
  it("caps new personal conversation mappings while retaining existing conversations",async()=>{
    const row=await personalBound();
    expect(await privateInbox.conversation(personalDmKey(direct))).toMatchObject({chat_id:personal.chatId,bot_id:personal.botId});
    await sql`INSERT INTO slack_personal_conversations(dm_key,owner_id,chat_id,bot_id,updated_at) SELECT md5(i::text),owner_id,chat_id,bot_id,updated_at FROM slack_personal_conversations CROSS JOIN generate_series(1,9999) AS i`.execute(db);
    const resolve=vi.fn(async()=>personal);expect((await privateInbox.bind(row,resolve)).chat_id).toBe(personal.chatId);expect(resolve).not.toHaveBeenCalled();
    const other={...direct,event:{...direct.event,eventId:"EvOther",channelId:"D456"}};await privateInbox.receive(other);const next=(await privateInbox.claim())!;
    await expect(privateInbox.bind(next,resolve)).rejects.toMatchObject({code:"capacity"});
  });
  it("caps pending and retained personal events and rejects another owner's event reuse",async()=>{
    await privateInbox.receive(direct);expect(await privateInbox.receive(direct)).toMatchObject({duplicate:true});
    await expect(privateInbox.receive({...direct,event:{...direct.event,text:"Changed"}})).rejects.toMatchObject({code:"conflict"});
    await expect(new SlackPersonalRepository(personalDb,"user_other",()=>now).receive(direct)).rejects.toMatchObject({code:"conflict"});
    await sql`INSERT INTO slack_personal_inbox(id,owner_id,dm_key,envelope,payload_hash,state,attempts,lease,lease_until,chat_id,bot_id,accepted_kind,accepted_id,created_at,updated_at) SELECT md5(i::text)::uuid,owner_id,dm_key,envelope,payload_hash,state,attempts,lease,lease_until,chat_id,bot_id,accepted_kind,accepted_id,created_at,updated_at FROM slack_personal_inbox CROSS JOIN generate_series(1,999) AS i`.execute(db);
    await expect(privateInbox.receive({...direct,event:{...direct.event,eventId:"EvCapacity"}})).rejects.toMatchObject({code:"capacity"});
    await db.updateTable("slack_personal_inbox").set({state:"failed"}).execute();
    await sql`INSERT INTO slack_personal_inbox(id,owner_id,dm_key,envelope,payload_hash,state,attempts,lease,lease_until,chat_id,bot_id,accepted_kind,accepted_id,created_at,updated_at) SELECT md5(i::text)::uuid,owner_id,dm_key,envelope,payload_hash,state,attempts,lease,lease_until,chat_id,bot_id,accepted_kind,accepted_id,created_at,updated_at FROM slack_personal_inbox CROSS JOIN generate_series(1000,9999) AS i WHERE id=${rowId(direct)}::uuid`.execute(db);
    await expect(privateInbox.receive({...direct,event:{...direct.event,eventId:"EvRetained"}})).rejects.toMatchObject({code:"capacity"});
  });
  it("retries personal leases with backoff and retires exhausted claims",async()=>{
    await privateInbox.receive(direct);const row=(await privateInbox.claim())!;await privateInbox.release(row,true);expect(await privateInbox.claim()).toBeNull();advance(10_001);const retry=(await privateInbox.claim())!;expect(retry.attempts).toBe(2);
    await db.updateTable("slack_personal_inbox").set({attempts:8}).execute();advance(61_000);expect(await privateInbox.claim()).toBeNull();expect((await db.selectFrom("slack_personal_inbox").select("state").executeTakeFirstOrThrow()).state).toBe("failed");
    const other={...direct,event:{...direct.event,eventId:"EvOther"}};await privateInbox.receive(other);const next=(await privateInbox.claim())!;await privateInbox.release(next,false);expect((await db.selectFrom("slack_personal_inbox").select("state").where("id","=",next.id).executeTakeFirstOrThrow()).state).toBe("failed");
  });
  it.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("fences simultaneous personal event identity insertion by different owners",async()=>{
    let arrived=0;let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const reads=new Set<object>();
    const plugin:KyselyPlugin={
      transformQuery(args){
        const node=JSON.stringify(args.node);
        if(args.node.kind==="SelectQueryNode"&&node.includes("slack_personal_inbox")&&node.includes("SelectAllNode"))reads.add(args.queryId);
        return args.node;
      },
      async transformResult(args){
        if(reads.delete(args.queryId)){arrived++;if(arrived===2)release();await gate;}
        return args.result;
      },
    };
    const timer=setTimeout(release,2000);
    try{
      const repos=[new SlackPersonalRepository(personalDb.withPlugin(plugin),"user_owner",()=>now),new SlackPersonalRepository(personalDb.withPlugin(plugin),"user_other",()=>now)];
      const outcomes=await Promise.allSettled(repos.map((repo,index)=>repo.receive({...direct,ownerId:index?"user_other":"user_owner",actorId:index?"user_other":"user_owner"})));
      expect(arrived).toBe(2);expect(outcomes.filter(result=>result.status==="fulfilled")).toHaveLength(1);
      expect(outcomes.find(result=>result.status==="rejected")).toMatchObject({reason:{code:"conflict"}});
      expect(await db.selectFrom("slack_personal_inbox").selectAll().execute()).toHaveLength(1);
    }finally{clearTimeout(timer);release();}
  });
  it("keeps personal completion bound to accepted identity and removes terminal history only",async()=>{
    const row=await personalBound();await privateInbox.accepted(row,{kind:"queue",id:"qturn_actual"});const accepted=(await privateInbox.waiting())[0];await privateInbox.deferResult(accepted);
    await privateInbox.finish({...accepted,accepted_id:"qturn_other"},{runId:"run_other",text:"Wrong"});expect(await db.selectFrom("slack_personal_outbox").selectAll().execute()).toHaveLength(0);
    await privateInbox.finish(accepted,{runId:"run_actual",text:"Answer"});const reply=(await privateInbox.claimReply())!;await privateInbox.replyStatus(reply.outbox.event_id,reply.outbox.lease,"pending");expect(await privateInbox.claimReply()).toBeNull();advance(30_001);
    const retry=(await privateInbox.claimReply())!;await privateInbox.replyStatus(retry.outbox.event_id,retry.outbox.lease,"sent","1790766001.000001");advance(31*86400_000);await privateInbox.cleanup();expect(await db.selectFrom("slack_personal_inbox").selectAll().execute()).toHaveLength(0);await privateInbox.finish(accepted,null);
    const other={...direct,event:{...direct.event,eventId:"EvOther"}};await privateInbox.receive(other);const next=(await privateInbox.claim())!;await privateInbox.accepted(next,{kind:"run",id:"run_failed"});await privateInbox.finish((await privateInbox.waiting())[0],null);expect((await db.selectFrom("slack_personal_inbox").select("state").executeTakeFirstOrThrow()).state).toBe("failed");
  });
  it("marks expired personal sends uncertain and preserves their evidence at cleanup",async()=>{
    const row=await personalBound();await privateInbox.accepted(row,{kind:"run",id:"run_actual"});await privateInbox.finish((await privateInbox.waiting())[0],{runId:"run_actual",text:"Answer"});await privateInbox.claimReply();advance(31_000);expect(await privateInbox.claimReply()).toBeNull();advance(31*86400_000);await privateInbox.cleanup();expect((await db.selectFrom("slack_personal_outbox").select("state").executeTakeFirstOrThrow()).state).toBe("uncertain");expect(await db.selectFrom("slack_personal_inbox").selectAll().execute()).toHaveLength(1);
  });
  it("parses durable company envelopes stored as encoded JSON",async()=>{
    const row=await companyBound();expect(company.envelope({...row,envelope:JSON.stringify(envelope)})).toEqual(envelope);expect(threadKey({...envelope,event:{...envelope.event,threadTs:envelope.event.ts}})).toBe(threadKey(envelope));
  });
});
