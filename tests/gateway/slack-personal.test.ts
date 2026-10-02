import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";
import { bootstrapSlackPersonalDatabase, SlackPersonalRepository, type SlackPersonalDatabase } from "../../packages/gateway/src/slack/personal-database.js";
import { SlackPersonalService, type SlackPersonalResult } from "../../packages/gateway/src/slack/personal-service.js";
import type { SlackBridgeEnvelope } from "@matrix-os/contracts/slack-bridge";
const now=new Date("2026-09-30T11:00:00Z");
const envelope:SlackBridgeEnvelope={ownerId:"user_owner",actorId:"user_owner",organizationId:"org_team",event:{appId:"A123",teamId:"T123",userId:"U123",channelId:"D123",eventId:"Ev123",ts:"1790766000.000001",text:"Help me plan the day",kind:"direct_message"}};
describe("durable private Slack personal transport",()=>{
 let fixture:CollaborationTestDatabase;let db:Kysely<SlackPersonalDatabase>;let completed=false;
 const resolvePersonalChat=vi.fn();const submitPersonal=vi.fn();const sendReply=vi.fn();let service:SlackPersonalService;
 function create(){return new SlackPersonalService({db,ownerId:envelope.ownerId,now:()=>now,resolvePersonalChat,submitPersonal,
 readResult:async()=>completed?{status:"completed",requestingActorId:"user_owner",runId:"run_private",text:"Private <@U123> & <!channel>"}:{status:"pending",requestingActorId:"user_owner"},sendReply});}
 beforeEach(async()=>{vi.resetAllMocks();completed=false;fixture=await createCollaborationTestDatabase();db=fixture.db as unknown as Kysely<SlackPersonalDatabase>;await bootstrapSlackPersonalDatabase(db);
 resolvePersonalChat.mockResolvedValue({chatId:"chat_private",botId:"bot_aaaaaaaa"});submitPersonal.mockResolvedValue({runId:"run_private"});sendReply.mockResolvedValue({status:"sent",messageTs:"1790766001.000001"});service=create();});
 afterEach(async()=>{await service.close();await fixture.destroy();});
 it("durably deduplicates before ACK and keeps one personal Chat across restart",async()=>{
  expect(await service.receive(envelope)).toMatchObject({accepted:true,duplicate:false});expect(await service.receive(envelope)).toMatchObject({accepted:true,duplicate:true});expect(submitPersonal).not.toHaveBeenCalled();
  await service.drain();expect(submitPersonal).toHaveBeenCalledTimes(1);await service.close();service=create();completed=true;await service.drain();await service.drain();
  expect(sendReply).toHaveBeenCalledTimes(1);expect(sendReply.mock.calls[0][0]).toMatchObject({envelope,chatId:"chat_private",runId:"run_private",text:"Private <@U123> & <!channel>"});
  await service.receive({...envelope,event:{...envelope.event,eventId:"Ev456"}});await service.drain();expect(resolvePersonalChat).toHaveBeenCalledTimes(1);
 });
 it("refuses channels, company flags, changed identities and substituted event payloads",async()=>{
  for(const bad of [{...envelope,actorId:"user_other"},{...envelope,channelScopeId:"10000000-0000-4000-8000-000000000001"},{...envelope,companyPublicationApproved:true},{...envelope,event:{...envelope.event,channelId:"C123"}},{...envelope,event:{...envelope.event,channelId:"G123"}},{...envelope,event:{...envelope.event,kind:"mention"}}]) await expect(service.receive(bad)).rejects.toMatchObject({code:"forbidden"});
  await service.receive(envelope);await expect(service.receive({...envelope,event:{...envelope.event,text:"Replace payload"}})).rejects.toMatchObject({code:"conflict"});expect(submitPersonal).not.toHaveBeenCalled();
 });
 it("never automatically repeats an ambiguous send",async()=>{
  await service.receive(envelope);await service.drain();completed=true;sendReply.mockResolvedValueOnce({status:"uncertain"});await service.drain();await service.drain();expect(sendReply).toHaveBeenCalledTimes(1);
  expect((await db.selectFrom("slack_personal_outbox").select("state").executeTakeFirstOrThrow()).state).toBe("uncertain");
 });
 it("rejects a canonical result belonging to another actor or accepted run",async()=>{
  service=new SlackPersonalService({db,ownerId:envelope.ownerId,now:()=>now,resolvePersonalChat,submitPersonal,sendReply,readResult:async()=>({status:"completed",requestingActorId:"user_other",runId:"run_other",text:"Wrong private data"})});
  await service.receive(envelope);await service.drain();expect(sendReply).not.toHaveBeenCalled();
 });
 it("reacts only after durable admission and preserves accepted work when a reaction fails",async()=>{
  const onAdmitted=vi.fn(async(input:typeof envelope)=>{
   expect(input).toEqual(envelope);
   expect((await db.selectFrom("slack_personal_inbox").select(["state","accepted_id"]).executeTakeFirstOrThrow())).toMatchObject({state:"accepted",accepted_id:"run_private"});
   throw new Error("Reaction temporarily unavailable");
  });
  service=new SlackPersonalService({db,ownerId:envelope.ownerId,now:()=>now,resolvePersonalChat,submitPersonal,sendReply,onAdmitted,
   readResult:async()=>({status:"pending",requestingActorId:envelope.ownerId})} as never);
  await service.receive(envelope);expect(onAdmitted).not.toHaveBeenCalled();
  await service.drain();await service.drain();
  expect(onAdmitted).toHaveBeenCalledTimes(1);expect(submitPersonal).toHaveBeenCalledTimes(1);
  expect((await db.selectFrom("slack_personal_inbox").select(["state","accepted_id"]).executeTakeFirstOrThrow())).toMatchObject({state:"accepted",accepted_id:"run_private"});
  const failed={...envelope,event:{...envelope.event,eventId:"EvFailed"}};
  submitPersonal.mockRejectedValueOnce(new Error("Admission unavailable"));
  await service.receive(failed);await service.drain();expect(onAdmitted).toHaveBeenCalledTimes(1);
 });
 it("delivers a later completed personal answer past twenty pending results across restart",async()=>{
  let currentTime=now;let answerCompleted=false;
  resolvePersonalChat.mockImplementation(async({dmKey})=>({chatId:`chat_${dmKey.slice(0,16)}`,botId:"bot_aaaaaaaa"}));
  submitPersonal.mockImplementation(async(record)=>({runId:`run_${record.envelope.event.eventId}`}));
  const createBatch=()=>new SlackPersonalService({db,ownerId:envelope.ownerId,now:()=>currentTime,resolvePersonalChat,submitPersonal,sendReply,
   readResult:async(record)=>answerCompleted&&record.envelope.event.eventId==="EvBATCH20"
    ? {status:"completed",requestingActorId:envelope.ownerId,runId:record.acceptedId,text:"Later personal answer"}
    : {status:"pending",requestingActorId:envelope.ownerId}});
  service=createBatch();
  const rows=[];
  for(let index=0;index<21;index++)rows.push(await service.receive({...envelope,event:{...envelope.event,eventId:`EvBATCH${index}`,channelId:`D${String(index).padStart(3,"0")}`}}));
  await service.drain();await service.drain();await service.drain();
  // Reproduce a restart with twenty older pending requests and a newer completed
  // request. None may permanently monopolize the bounded reconciliation batch.
  for(let index=0;index<rows.length;index++)await db.updateTable("slack_personal_inbox").set({updated_at:new Date(now.getTime()+index)}).where("id","=",rows[index].eventId).execute();
  await service.close();answerCompleted=true;currentTime=new Date(now.getTime()+60_000);service=createBatch();
  await service.drain();currentTime=new Date(now.getTime()+61_000);await service.drain();await service.drain();
  expect(sendReply).toHaveBeenCalledTimes(1);
  expect(sendReply).toHaveBeenCalledWith(expect.objectContaining({runId:"run_EvBATCH20",text:"Later personal answer"}));
  expect(submitPersonal).toHaveBeenCalledTimes(21);
 });
 it("rejects stale events and stops new work while allowing an in-flight admission to settle",async()=>{
  expect(()=>new SlackPersonalService({ownerId:""} as never)).toThrow("Missing Slack runtime owner");
  for(const ts of [String(now.getTime()/1000-8*86400)+".1",String(now.getTime()/1000+301)+".1"])
   await expect(service.receive({...envelope,event:{...envelope.event,ts}})).rejects.toMatchObject({code:"forbidden"});
  let release!:()=>void;submitPersonal.mockImplementation(()=>new Promise(resolve=>{release=()=>resolve({runId:"run_private"});}));
  await service.receive(envelope);const draining=service.drain();expect(service.drain()).toBe(draining);
  await vi.waitFor(()=>expect(submitPersonal).toHaveBeenCalledOnce());let closed=false;const closing=service.close().then(()=>{closed=true;});
  await Promise.resolve();expect(closed).toBe(false);await expect(service.receive(envelope)).rejects.toMatchObject({code:"unavailable"});
  release();await closing;await service.drain();expect(submitPersonal).toHaveBeenCalledOnce();
 });
 it("uses the live default clock and prepares one durable DM before mapping, with bounded input",async()=>{
  const preparePersonalChat=vi.fn(async()=>({chatId:"chat_private",botId:"bot_aaaaaaaa"}));
  const readResult=vi.fn(async()=>({status:"pending" as const,requestingActorId:envelope.ownerId}));
  service=new SlackPersonalService({db,ownerId:envelope.ownerId,preparePersonalChat,resolvePersonalChat,submitPersonal,readResult,sendReply});
  const live={...envelope,event:{...envelope.event,ts:String(Math.floor(Date.now()/1000))+".1",text:"x".repeat(9000)}};
  await service.receive(live);await service.drain();expect(preparePersonalChat).toHaveBeenCalledOnce();
  expect(resolvePersonalChat).toHaveBeenCalledWith(expect.objectContaining({prepared:{chatId:"chat_private",botId:"bot_aaaaaaaa"}}),expect.anything());
  expect(submitPersonal.mock.calls[0][0].text).toBe("x".repeat(8000)+"\n(Slack message truncated.)");
  await service.receive({...live,event:{...live.event,eventId:"EvNext"}});await service.drain();expect(preparePersonalChat).toHaveBeenCalledOnce();
 });
 it("expires uncertain receipts after bounded retention without resending them",async()=>{
  sendReply.mockResolvedValue({status:"uncertain"});completed=true;
  await service.receive(envelope);await service.drain();expect(sendReply).toHaveBeenCalledOnce();
  let clock=new Date(now.getTime()+29*86400_000);
  const repository=new SlackPersonalRepository(db,envelope.ownerId,()=>clock);
  await repository.cleanup();expect(await db.selectFrom("slack_personal_inbox").selectAll().execute()).toHaveLength(1);
  expect(await repository.claimReply()).toBeNull();
  clock=new Date(now.getTime()+31*86400_000);await repository.cleanup();
  expect(await db.selectFrom("slack_personal_inbox").selectAll().execute()).toHaveLength(0);
  expect(await db.selectFrom("slack_personal_outbox").selectAll().execute()).toHaveLength(0);
  expect(sendReply).toHaveBeenCalledOnce();
 });
 it("records a queued acceptance and rejects missing or malformed canonical admission IDs",async()=>{
  submitPersonal.mockResolvedValueOnce({queuedTurnId:"qturn_private"});await service.receive(envelope);await service.drain();
  expect(await db.selectFrom("slack_personal_inbox").select(["state","accepted_kind","accepted_id"]).executeTakeFirstOrThrow()).toMatchObject({state:"accepted",accepted_kind:"queue",accepted_id:"qturn_private"});
  for(const accepted of [{runId:"bad"},{queuedTurnId:"bad"},{}]){
   submitPersonal.mockResolvedValueOnce(accepted);const next={...envelope,event:{...envelope.event,eventId:`EvBad${Object.keys(accepted)[0]??"Empty"}`}};
   const row=await service.receive(next);await service.drain();expect(await db.selectFrom("slack_personal_inbox").select("state").where("id","=",row.eventId).executeTakeFirstOrThrow()).toEqual({state:"failed"});
  }
 });
 it("retries unavailable admission but fails revoked admission without reacting",async()=>{
  const onAdmitted=vi.fn(),readResult=vi.fn(async()=>({status:"pending" as const,requestingActorId:envelope.ownerId}));
  service=new SlackPersonalService({db,ownerId:envelope.ownerId,now:()=>now,resolvePersonalChat,submitPersonal,readResult,sendReply,onAdmitted});
  submitPersonal.mockRejectedValueOnce("connection unavailable");const first=await service.receive(envelope);await service.drain();
  expect(await db.selectFrom("slack_personal_inbox").select("state").where("id","=",first.eventId).executeTakeFirstOrThrow()).toEqual({state:"pending"});
  submitPersonal.mockRejectedValueOnce(Object.assign(new Error("revoked"),{code:"forbidden"}));const second=await service.receive({...envelope,event:{...envelope.event,eventId:"EvDenied"}});await service.drain();
  expect(await db.selectFrom("slack_personal_inbox").select("state").where("id","=",second.eventId).executeTakeFirstOrThrow()).toEqual({state:"failed"});expect(onAdmitted).not.toHaveBeenCalled();
 });
 it("fails corrupt durable personal mappings closed and defers temporary result outages",async()=>{
  const readResult=vi.fn().mockRejectedValueOnce("temporary outage").mockResolvedValue({status:"pending",requestingActorId:envelope.ownerId});
  service=new SlackPersonalService({db,ownerId:envelope.ownerId,now:()=>now,resolvePersonalChat,submitPersonal,readResult,sendReply});
  const row=await service.receive(envelope);await service.drain();expect(await db.selectFrom("slack_personal_inbox").select("state").where("id","=",row.eventId).executeTakeFirstOrThrow()).toEqual({state:"accepted"});
  await db.updateTable("slack_personal_inbox").set({dm_key:"wrong"}).where("id","=",row.eventId).execute();await service.drain();
  expect(await db.selectFrom("slack_personal_inbox").select("state").where("id","=",row.eventId).executeTakeFirstOrThrow()).toEqual({state:"failed"});expect(sendReply).not.toHaveBeenCalled();
 });
 it("does not deliver failed, empty or substituted accepted-run results",async()=>{
  const readResult=vi.fn();service=new SlackPersonalService({db,ownerId:envelope.ownerId,now:()=>now,resolvePersonalChat,submitPersonal,readResult,sendReply});
  const results:SlackPersonalResult[]=[{status:"failed",requestingActorId:envelope.ownerId},{status:"completed",requestingActorId:envelope.ownerId,runId:"run_private",text:""},{status:"completed",requestingActorId:envelope.ownerId,text:"unbound"},{status:"completed",requestingActorId:envelope.ownerId,runId:"run_other",text:"wrong"}];
  for(let i=0;i<results.length;i++){readResult.mockResolvedValueOnce(results[i]);await service.receive({...envelope,event:{...envelope.event,eventId:`EvResult${i}`}});await service.drain();}
  expect(sendReply).not.toHaveBeenCalled();expect((await db.selectFrom("slack_personal_inbox").select("state").execute()).every(row=>row.state==="failed")).toBe(true);
 });
 it("limits confirmed retryable delivery to three attempts and treats thrown sends as uncertain",async()=>{
  let clock=now;const readResult=vi.fn(async()=>({status:"completed" as const,requestingActorId:envelope.ownerId,runId:"run_private",text:"Answer"}));
  service=new SlackPersonalService({db,ownerId:envelope.ownerId,now:()=>clock,resolvePersonalChat,submitPersonal,readResult,sendReply});
  sendReply.mockResolvedValue({status:"retryable"});await service.receive(envelope);await service.drain();
  clock=new Date(now.getTime()+31_000);await service.drain();clock=new Date(now.getTime()+62_000);await service.drain();await service.drain();
  expect(sendReply).toHaveBeenCalledTimes(3);expect(await db.selectFrom("slack_personal_outbox").select("state").executeTakeFirstOrThrow()).toEqual({state:"failed"});
  sendReply.mockRejectedValueOnce("socket failed");await service.receive({...envelope,event:{...envelope.event,eventId:"EvUnknown"}});await service.drain();
  expect((await db.selectFrom("slack_personal_outbox").select("state").execute()).map(row=>row.state)).toContain("uncertain");
 });
 it("revalidates the accepted run again immediately before private delivery",async()=>{
  const readResult=vi.fn().mockResolvedValueOnce({status:"completed",requestingActorId:envelope.ownerId,runId:"run_private",text:"Answer"}).mockResolvedValueOnce({status:"pending",requestingActorId:envelope.ownerId});
  service=new SlackPersonalService({db,ownerId:envelope.ownerId,now:()=>now,resolvePersonalChat,submitPersonal,readResult,sendReply});
  await service.receive(envelope);await service.drain();expect(sendReply).not.toHaveBeenCalled();expect(await db.selectFrom("slack_personal_outbox").select("state").executeTakeFirstOrThrow()).toEqual({state:"failed"});
 });

 it("reconciles a canonical admission after its inbox lease expires without losing or changing the accepted run",async()=>{
  let clock=now;let release!:()=>void;const readResult=vi.fn(async()=>({status:"pending" as const,requestingActorId:envelope.ownerId}));
  const submissions=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{release=()=>resolve({runId:"run_private"});})).mockResolvedValue({runId:"run_private"});
  const createLeased=()=>new SlackPersonalService({db,ownerId:envelope.ownerId,now:()=>clock,resolvePersonalChat,submitPersonal:submissions,readResult,sendReply});
  service=createLeased();await service.receive(envelope);const first=service.drain();await vi.waitFor(()=>expect(submissions).toHaveBeenCalledOnce());
  clock=new Date(now.getTime()+61_000);const replacement=createLeased();
  try{await replacement.drain();release();await first;
   expect(submissions).toHaveBeenCalledTimes(2);expect(submissions.mock.calls[1][0]).toEqual(submissions.mock.calls[0][0]);
   expect(await db.selectFrom("slack_personal_inbox").select(["state","accepted_id","attempts"]).executeTakeFirstOrThrow()).toEqual({state:"accepted",accepted_id:"run_private",attempts:2});
   expect(await db.selectFrom("slack_personal_conversations").select("chat_id").execute()).toHaveLength(1);expect(sendReply).not.toHaveBeenCalled();
  }finally{release();await first;await replacement.close();}
 });

});

import { createBotStateDatabase, insertChat } from "./bots/bot-state-support.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import type { ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { createSlackPersonalSubmitter, createSlackPersonalResultReader, createSlackPersonalChatResolver, type SlackPersonalRecord } from "../../packages/gateway/src/slack/personal-service.js";
import { MATRIX_BOT_SELECTION } from "@matrix-os/contracts";
describe("personal Slack canonical Pi seams",()=>{
 let fixture:Awaited<ReturnType<typeof createBotStateDatabase>>;
 const record:SlackPersonalRecord={envelope,eventId:"receipt",clientRequestId:"req_slack_private",chatId:"chat_private",botId:"bot_aaaaaaaa",text:envelope.event.text};
 beforeEach(async()=>{fixture=await createBotStateDatabase();await insertChat(fixture.db,record.chatId,envelope.ownerId);await fixture.db.insertInto("bot_chat_bindings").values({owner_id:envelope.ownerId,bot_id:record.botId,chat_id:record.chatId,kind:"direct",created_at:now,removed_at:null}).execute();});
 afterEach(async()=>fixture.destroy());
 it("admits the first unbound direct Chat through canonical Pi without inventing a provider binding",async()=>{
  const admitTurn=vi.fn(async()=>({run:{id:"run_first"}}));const enqueueQueuedTurn=vi.fn();
  const submit=createSlackPersonalSubmitter({db:fixture.db,orchestrator:{admitTurn,enqueueQueuedTurn} as never});
  expect(await submit(record)).toEqual({runId:"run_first"});expect(admitTurn).toHaveBeenCalledWith({userId:envelope.ownerId,source:"platform-verified"},{type:"personal",ownerId:envelope.ownerId},record.chatId,expect.objectContaining({selection:MATRIX_BOT_SELECTION,clientRequestId:record.clientRequestId}));expect(enqueueQueuedTurn).not.toHaveBeenCalled();
  expect((await fixture.db.selectFrom("chats").select("bound_driver_kind").executeTakeFirstOrThrow()).bound_driver_kind).toBeNull();
 });
 it("instantiates with one durable DM request before opening the mapping transaction",async()=>{
  const instantiate=vi.fn(async()=>({agent:{id:record.botId},chatId:record.chatId,operation:"replayed"}));
  const resolver=createSlackPersonalChatResolver({ownerId:envelope.ownerId,instantiation:{instantiate} as never});
  const {personalDmKey}=await import("../../packages/gateway/src/slack/personal-database.js");const request={envelope,dmKey:personalDmKey(envelope)};
  const prepared=await resolver.preparePersonalChat(request);
  const result=await fixture.db.transaction().execute(trx=>resolver.resolvePersonalChat({...request,prepared},trx as unknown as import("kysely").Transaction<SlackPersonalDatabase>));
  expect(result).toEqual({chatId:record.chatId,botId:record.botId});expect(instantiate).toHaveBeenCalledTimes(1);
  expect(instantiate).toHaveBeenCalledWith(envelope.ownerId,expect.objectContaining({recipe:{recipeId:"personal-assistant",version:"2026-09-30.1"},clientRequestId:expect.stringMatching(/^req_[a-f0-9]{64}$/)}));
  await resolver.preparePersonalChat(request);expect(instantiate.mock.calls[1]).toEqual(instantiate.mock.calls[0]);
 });
 it("queues only while the same canonical personal Chat has an active Pi run",async()=>{
  await seedRun(fixture,record);await fixture.db.updateTable("chat_runs").set({status:"running"}).where("id","=","run_private").execute();
  const admitTurn=vi.fn(),enqueueQueuedTurn=vi.fn(async()=>({queuedTurn:{id:"qturn_followup"}}));
  const submit=createSlackPersonalSubmitter({db:fixture.db,orchestrator:{admitTurn,enqueueQueuedTurn} as never});
  await expect(submit({...record,clientRequestId:"req_followup",text:"Follow up"})).resolves.toEqual({queuedTurnId:"qturn_followup"});expect(admitTurn).not.toHaveBeenCalled();expect(enqueueQueuedTurn).toHaveBeenCalledTimes(1);
  await expect(submit(record)).resolves.toEqual({runId:"run_private"});expect(enqueueQueuedTurn).toHaveBeenCalledTimes(1);
 });
 it("reads only this accepted personal run and refuses a changed actor or shared audience",async()=>{
  await seedRun(fixture,record);
  const read=createSlackPersonalResultReader(fixture.db),accepted={...record,acceptedKind:"run" as const,acceptedId:"run_private"};
  await expect(read(accepted)).resolves.toMatchObject({status:"completed",runId:"run_private",text:"Only the selected private run"});
  await expect(read({...accepted,acceptedId:"run_unrelated"})).rejects.toMatchObject({code:"forbidden"});
  await fixture.db.updateTable("chat_messages").set({actor_id:"user_other"}).where("id","=","msg_input").execute();
  await expect(read(accepted)).rejects.toMatchObject({code:"forbidden"});
  await fixture.db.updateTable("chats").set({collaboration:JSON.stringify({scopeId:"10000000-0000-4000-8000-000000000001",mode:"shared_ai",executionFenced:true})}).where("id","=",record.chatId).execute();
  await expect(read(accepted)).rejects.toMatchObject({code:"forbidden"});
 });

 it("uses the stored mapping on later DMs with the production resolver",async()=>{
  const db=fixture.db as unknown as Kysely<SlackPersonalDatabase>;
  await bootstrapSlackPersonalDatabase(db);
  const instantiate=vi.fn(async()=>({agent:{id:record.botId},chatId:record.chatId,operation:"replayed"}));
  const resolver=createSlackPersonalChatResolver({ownerId:envelope.ownerId,instantiation:{instantiate} as never});
  const submitPersonal=vi.fn(async(_input:SlackPersonalRecord)=>({runId:"run_dm"}));
  const service=new SlackPersonalService({db,ownerId:envelope.ownerId,now:()=>now,...resolver,submitPersonal,
    readResult:async()=>({status:"pending",requestingActorId:envelope.ownerId}),sendReply:vi.fn()});
  try{
    await service.receive(envelope);await service.drain();
    await service.receive({...envelope,event:{...envelope.event,eventId:"EvSecond",text:"Follow-up"}});await service.drain();
    expect(instantiate).toHaveBeenCalledOnce();
    expect(submitPersonal).toHaveBeenCalledTimes(2);
    expect(submitPersonal.mock.calls.map(([input])=>({chatId:input.chatId,botId:input.botId}))).toEqual([
      {chatId:record.chatId,botId:record.botId},{chatId:record.chatId,botId:record.botId},
    ]);
    expect((await db.selectFrom("slack_personal_inbox").select("state").execute()).map(row=>row.state)).toEqual(["accepted","accepted"]);
  }finally{await service.close();}
 });
 it("denies missing preparation and substituted personal recipe identities",async()=>{
  const instantiate=vi.fn(),resolver=createSlackPersonalChatResolver({ownerId:envelope.ownerId,instantiation:{instantiate} as never});
  const {personalDmKey}=await import("../../packages/gateway/src/slack/personal-database.js");const request={envelope,dmKey:personalDmKey(envelope)};
  await expect(resolver.preparePersonalChat({...request,dmKey:"wrong"})).rejects.toMatchObject({code:"forbidden"});expect(instantiate).not.toHaveBeenCalled();
  await expect(fixture.db.transaction().execute(trx=>resolver.resolvePersonalChat(request,trx as never))).rejects.toMatchObject({code:"unavailable"});
 });
 it("denies personal execution when the DM identity or bound harness was replaced",async()=>{
  const admitTurn=vi.fn(),submit=createSlackPersonalSubmitter({db:fixture.db,orchestrator:{admitTurn,enqueueQueuedTurn:vi.fn()} as never});
  await expect(submit({...record,envelope:{...envelope,actorId:"user_other"}})).rejects.toMatchObject({code:"forbidden"});
  await fixture.db.updateTable("chats").set({bound_driver_kind:"other"}).where("id","=",record.chatId).execute();await expect(submit(record)).rejects.toMatchObject({code:"forbidden"});
  await fixture.db.updateTable("chats").set({bound_driver_kind:"matrix_bot",bound_instance_id:"other"}).where("id","=",record.chatId).execute();await expect(submit(record)).rejects.toMatchObject({code:"forbidden"});
  expect(admitTurn).not.toHaveBeenCalled();
 });
 it("reconciles only identical durable admission payloads and never resubmits a changed request",async()=>{
  await seedRun(fixture,record);const admitTurn=vi.fn(),submit=createSlackPersonalSubmitter({db:fixture.db,orchestrator:{admitTurn,enqueueQueuedTurn:vi.fn()} as never});
  await fixture.db.updateTable("chat_messages").set({parts:sql`${JSON.stringify(JSON.stringify([{type:"text",text:record.text}]))}::jsonb`}).where("id","=","msg_input").execute();
  expect(await submit(record)).toEqual({runId:"run_private"});await expect(submit({...record,text:"changed"})).rejects.toMatchObject({code:"conflict"});expect(admitTurn).not.toHaveBeenCalled();
 });
 it("reconciles exact queued payloads and reads only their claimed personal run",async()=>{
  await fixture.db.insertInto("chat_queued_turns").values({id:"qturn_private",chat_id:record.chatId,client_request_id:record.clientRequestId,position:1,status:"queued",parts:JSON.stringify([{type:"text",text:record.text}]),driver_kind:"matrix_bot",instance_id:MATRIX_BOT_SELECTION.instanceId,selection:JSON.stringify(MATRIX_BOT_SELECTION),interaction_mode:"default",permission_mode:"supervised",execution_root:null,execution_root_fingerprint:null,capability_snapshot:JSON.stringify({}),claimed_turn_id:null,claimed_run_id:null,cancelled_at:null,created_at:now,updated_at:now}).execute();
  const admitTurn=vi.fn(),submit=createSlackPersonalSubmitter({db:fixture.db,orchestrator:{admitTurn,enqueueQueuedTurn:vi.fn()} as never});
  expect(await submit(record)).toEqual({queuedTurnId:"qturn_private"});await expect(submit({...record,text:"changed"})).rejects.toMatchObject({code:"conflict"});
  const read=createSlackPersonalResultReader(fixture.db),accepted={...record,acceptedKind:"queue" as const,acceptedId:"qturn_private"};
  await expect(read({...record})).rejects.toMatchObject({code:"forbidden"});await expect(read({...accepted,acceptedId:"qturn_missing"})).rejects.toMatchObject({code:"forbidden"});
  expect(await read(accepted)).toMatchObject({status:"pending"});await fixture.db.updateTable("chat_queued_turns").set({status:"cancelled"}).execute();expect(await read(accepted)).toMatchObject({status:"failed"});
  const repository=new ChatRepository(fixture.db as unknown as Kysely<ChatDatabase>);
  const capability={revision:"test",rootChat:true,attachments:[],resources:[],tools:[],approvals:false,userInput:false,resume:false,cancellation:true,steering:"none",worktrees:"none",interactionModes:["default"],permissionModes:["supervised"]};
  await fixture.db.updateTable("chat_queued_turns").set({status:"queued",capability_snapshot:JSON.stringify(capability)}).execute();
  const owner={type:"personal" as const,ownerId:envelope.ownerId};
  expect(await repository.claimNextQueuedTurn(owner,{chatId:record.chatId,turnId:"cturn_private",runId:"run_private",messageId:"msg_input",claimedAt:now.toISOString()})).not.toBeNull();
  await repository.appendAssistantDelta(owner,{chatId:record.chatId,runId:"run_private",messageId:"msg_output",delta:"Only the selected private run",createdAt:now.toISOString()});
  await repository.finishRun(owner,{chatId:record.chatId,runId:"run_private",outcome:"completed",completedAt:now.toISOString()});
  expect(await read(accepted)).toMatchObject({status:"completed",text:"Only the selected private run"});
  await fixture.db.updateTable("chat_queued_turns").set({parts:sql`${JSON.stringify(JSON.stringify([{type:"text",text:record.text}]))}::jsonb`}).execute();
  await fixture.db.deleteFrom("chat_runs").execute();expect(await submit(record)).toEqual({queuedTurnId:"qturn_private"});
  await fixture.db.updateTable("chat_queued_turns").set({collaboration_scope_id:"10000000-0000-4000-8000-000000000001"}).execute();await expect(submit(record)).rejects.toMatchObject({code:"conflict"});await expect(read(accepted)).rejects.toMatchObject({code:"forbidden"});expect(admitTurn).not.toHaveBeenCalled();
 });
 it("projects active and failed run states and returns only bounded committed text parts",async()=>{
  await seedRun(fixture,record);const read=createSlackPersonalResultReader(fixture.db),accepted={...record,acceptedKind:"run" as const,acceptedId:"run_private"};
  await fixture.db.updateTable("chat_runs").set({status:"running"}).execute();expect(await read(accepted)).toMatchObject({status:"pending"});
  await fixture.db.updateTable("chat_runs").set({status:"failed"}).execute();expect(await read(accepted)).toMatchObject({status:"failed"});
  await fixture.db.updateTable("chat_runs").set({status:"completed"}).execute();
  await fixture.db.updateTable("chat_messages").set({parts:sql`${JSON.stringify(JSON.stringify([{type:"text",text:"a".repeat(13000)},{type:"summary",text:"non-reply summary",source:"assistant"}]))}::jsonb`}).where("id","=","msg_output").execute();
  expect((await read(accepted)).text).toBe("a".repeat(12000));
 });
 async function seedRun(fixture:Awaited<ReturnType<typeof createBotStateDatabase>>,record:SlackPersonalRecord){
  const repository=new ChatRepository(fixture.db as unknown as Kysely<ChatDatabase>);
  await repository.admitTurn({type:"personal",ownerId:envelope.ownerId},{chatId:record.chatId,baseRevision:0,
   message:{id:"msg_input",chatId:record.chatId,seq:1,role:"user",state:"committed",actorId:envelope.ownerId,purpose:"ai_request",turnId:"cturn_private",parts:[{type:"text",text:record.text}],createdAt:now.toISOString()},
   turn:{id:"cturn_private",chatId:record.chatId,clientRequestId:record.clientRequestId,baseMessageSeq:0,inputMessageId:"msg_input",status:"accepted",createdAt:now.toISOString(),updatedAt:now.toISOString()},
   run:{id:"run_private",chatId:record.chatId,turnId:"cturn_private",driverKind:"matrix_bot",instanceId:MATRIX_BOT_SELECTION.instanceId,selection:MATRIX_BOT_SELECTION,attempt:1,status:"accepted",interactionMode:"default",permissionMode:"supervised",historyBoundarySeq:0,
    capabilitySnapshot:{revision:"test",rootChat:true,attachments:[],resources:[],tools:[],approvals:false,userInput:false,resume:false,cancellation:true,steering:"none",worktrees:"none",interactionModes:["default"],permissionModes:["supervised"]},createdAt:now.toISOString(),updatedAt:now.toISOString()}});
  await fixture.db.updateTable("chat_runs").set({status:"completed"}).where("id","=","run_private").execute();
  await fixture.db.insertInto("chat_messages").values({id:"msg_output",chat_id:record.chatId,seq:2,role:"assistant",purpose:"assistant",state:"committed",turn_id:"cturn_private",run_id:"run_private",actor_id:null,parts:JSON.stringify([{type:"text",text:"Only the selected private run"}]),byte_count:30,search_text:"Only the selected private run",created_at:now}).execute();
 }
});
