import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";
import { createCollaborationTestDatabase, type CollaborationTestDatabase } from "./collaboration-test-support.js";
import { bootstrapSlackPersonalDatabase, type SlackPersonalDatabase } from "../../packages/gateway/src/slack/personal-database.js";
import { SlackPersonalService } from "../../packages/gateway/src/slack/personal-service.js";
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
});

import { createBotStateDatabase, insertChat } from "./bots/bot-state-support.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
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
 async function seedRun(fixture:Awaited<ReturnType<typeof createBotStateDatabase>>,record:SlackPersonalRecord){
  const repository=new ChatRepository(fixture.db);
  await repository.admitTurn({type:"personal",ownerId:envelope.ownerId},{chatId:record.chatId,baseRevision:0,
   message:{id:"msg_input",chatId:record.chatId,seq:1,role:"user",state:"committed",actorId:envelope.ownerId,purpose:"ai_request",turnId:"cturn_private",parts:[{type:"text",text:record.text}],createdAt:now.toISOString()},
   turn:{id:"cturn_private",chatId:record.chatId,clientRequestId:record.clientRequestId,baseMessageSeq:0,inputMessageId:"msg_input",status:"accepted",createdAt:now.toISOString(),updatedAt:now.toISOString()},
   run:{id:"run_private",chatId:record.chatId,turnId:"cturn_private",driverKind:"matrix_bot",instanceId:MATRIX_BOT_SELECTION.instanceId,selection:MATRIX_BOT_SELECTION,attempt:1,status:"accepted",interactionMode:"default",permissionMode:"supervised",historyBoundarySeq:0,
    capabilitySnapshot:{revision:"test",rootChat:true,attachments:[],resources:[],tools:[],approvals:false,userInput:false,resume:false,cancellation:true,steering:"none",worktrees:"none",interactionModes:["default"],permissionModes:["supervised"]},createdAt:now.toISOString(),updatedAt:now.toISOString()}});
  await fixture.db.updateTable("chat_runs").set({status:"completed"}).where("id","=","run_private").execute();
  await fixture.db.insertInto("chat_messages").values({id:"msg_output",chat_id:record.chatId,seq:2,role:"assistant",purpose:"assistant",state:"committed",turn_id:"cturn_private",run_id:"run_private",actor_id:null,parts:JSON.stringify([{type:"text",text:"Only the selected private run"}]),byte_count:30,search_text:"Only the selected private run",created_at:now}).execute();
 }
});
