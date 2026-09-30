import { SlackBridgeEnvelopeSchema, type SlackBridgeEnvelope } from "@matrix-os/contracts/slack-bridge";
import { CanonicalChatMessageSchema, MATRIX_BOT_SELECTION, MATRIX_BOT_INSTANCE_ID } from "@matrix-os/contracts";
import { type Kysely, type Transaction } from "kysely";
import type { OwnerBotDatabase } from "../bots/database.js";
import type { BotInstantiation } from "../bots/instantiation.js";
import type { CanonicalChatOrchestrator } from "../chat/orchestrator.js";
import { SlackCompanyError } from "./schemas.js";
import { SlackPersonalRepository, personalDmKey, personalDigest, type SlackPersonalDatabase, type SlackPersonalConversation, type SlackPersonalInbox } from "./personal-database.js";
export interface SlackPersonalRecord {envelope:SlackBridgeEnvelope;eventId:string;clientRequestId:string;chatId:string;botId:string;text:string;acceptedKind?:"run"|"queue";acceptedId?:string}
export interface SlackPersonalResult {status:"pending"|"completed"|"failed";requestingActorId:string;runId?:string;text?:string}
export interface SlackPersonalOptions {
 db:Kysely<SlackPersonalDatabase>;ownerId:string;now?:()=>Date;
 /** Create the recipe bot/direct Chat before opening the durable DM mapping transaction. */
 preparePersonalChat?(input:{envelope:SlackBridgeEnvelope;dmKey:string}):Promise<SlackPersonalConversation>;
 resolvePersonalChat(input:{envelope:SlackBridgeEnvelope;dmKey:string;prepared?:SlackPersonalConversation},trx:Transaction<SlackPersonalDatabase>):Promise<SlackPersonalConversation>;
 submitPersonal(record:SlackPersonalRecord):Promise<{runId:string;queuedTurnId?:never}|{queuedTurnId:string;runId?:never}>;
 /** Best-effort acknowledgement after canonical admission has been durably recorded. */
 onAdmitted?(envelope:SlackBridgeEnvelope):Promise<void>;
 readResult(record:SlackPersonalRecord):Promise<SlackPersonalResult>;
 sendReply(input:SlackPersonalRecord&{runId:string;text:string}):Promise<{status:"sent";messageTs:string}|{status:"retryable"|"uncertain"}>;
}
/** A D-only durable transport. The signed bridge route authenticates every receive request. */
export class SlackPersonalService {
 private readonly repository:SlackPersonalRepository;private readonly now:()=>Date;private stopping=false;private active:Promise<void>|null=null;
 constructor(private readonly options:SlackPersonalOptions){if(!options.ownerId)throw new Error("Missing Slack runtime owner");this.now=options.now??(()=>new Date());this.repository=new SlackPersonalRepository(options.db,options.ownerId,this.now);}
 private envelope(raw:unknown){const envelope=SlackBridgeEnvelopeSchema.parse(raw);
  if(envelope.ownerId!==this.options.ownerId||envelope.actorId!==envelope.ownerId||envelope.event.kind!=="direct_message"||!envelope.event.channelId.startsWith("D")||envelope.channelScopeId!==undefined||envelope.companyPublicationApproved!==undefined)throw new SlackCompanyError("forbidden");
  return envelope;
 }
 async receive(raw:unknown){if(this.stopping)throw new SlackCompanyError("unavailable");const envelope=this.envelope(raw);const time=Number(envelope.event.ts.split(".")[0])*1000;
  if(time<this.now().getTime()-7*86400_000||time>this.now().getTime()+300_000)throw new SlackCompanyError("forbidden");return this.repository.receive(envelope);
 }
 drain():Promise<void>{if(this.stopping||this.active)return this.active??Promise.resolve();this.active=this.work().finally(()=>{this.active=null;});return this.active;}
 async close(){this.stopping=true;await this.active;}
 private record(row:SlackPersonalInbox):SlackPersonalRecord{const envelope=this.envelope(typeof row.envelope==="string"?JSON.parse(row.envelope):row.envelope);
  if(!row.chat_id||!row.bot_id||personalDmKey(envelope)!==row.dm_key)throw new SlackCompanyError("forbidden");
  let text=envelope.event.text.slice(0,8000);if(envelope.event.text.length>8000)text+="\n(Slack message truncated.)";
  return {envelope,eventId:row.id,clientRequestId:`req_${row.id.replaceAll("-","")}`,chatId:row.chat_id,botId:row.bot_id,text,...(row.accepted_id&&row.accepted_kind?{acceptedId:row.accepted_id,acceptedKind:row.accepted_kind}:{})};
 }
 private async work(){await this.repository.cleanup();for(let index=0;index<10&&!this.stopping;index++){
  const row=await this.repository.claim();if(!row)break;
  try{const envelope=this.envelope(typeof row.envelope==="string"?JSON.parse(row.envelope):row.envelope);
   const existing=await this.repository.conversation(row.dm_key);
   const prepared=!existing&&this.options.preparePersonalChat?await this.options.preparePersonalChat({envelope,dmKey:row.dm_key}):undefined;
   const pinned=await this.repository.bind(row,trx=>this.options.resolvePersonalChat({envelope,dmKey:row.dm_key,...(prepared?{prepared}:{})},trx));
   const accepted=await this.options.submitPersonal(this.record(pinned));
   const kind=accepted.runId?"run":"queue",id=accepted.runId??accepted.queuedTurnId;
   if(!id||!new RegExp(kind==="run"?"^run_[A-Za-z0-9_.:-]{1,123}$":"^qturn_[A-Za-z0-9_.:-]{1,122}$").test(id))throw new SlackCompanyError("conflict");
   await this.repository.accepted(row,{kind,id});
   if(this.options.onAdmitted)try{await this.options.onAdmitted(envelope);}catch(error:unknown){console.warn("[slack-personal] reaction unavailable",error instanceof Error?error.name:"UnknownError");}
  }catch(error:unknown){console.warn("[slack-personal] canonical admission unavailable",error instanceof Error?error.name:"UnknownError");await this.repository.release(row,!denied(error));}
 }
 for(const row of await this.repository.waiting())try{const record=this.record(row);const result=await this.options.readResult(record);
  this.requireResult(record,result);if(result.status==="pending"){await this.repository.deferResult(row);continue;}
  await this.repository.finish(row,result.status==="completed"&&result.runId&&result.text?{runId:result.runId,text:result.text.slice(0,12_000)}:null);
 }catch(error:unknown){console.warn("[slack-personal] result unavailable",error instanceof Error?error.name:"UnknownError");if(denied(error))await this.repository.finish(row,null);else await this.repository.deferResult(row);}
 for(let index=0;index<10&&!this.stopping;index++){const delivery=await this.repository.claimReply();if(!delivery)break;const {inbox,outbox}=delivery;
  try{const record=this.record(inbox);const result=await this.options.readResult(record);this.requireResult(record,result);
   if(result.status!=="completed"||result.runId!==outbox.run_id)throw new SlackCompanyError("forbidden");
   const sent=await this.options.sendReply({...record,runId:outbox.run_id,text:outbox.text});
   await this.repository.replyStatus(outbox.event_id,outbox.lease,sent.status==="sent"?"sent":sent.status==="uncertain"?"uncertain":outbox.attempts<3?"pending":"failed",sent.status==="sent"?sent.messageTs:undefined);
  }catch(error:unknown){console.warn("[slack-personal] delivery unavailable",error instanceof Error?error.name:"UnknownError");await this.repository.replyStatus(outbox.event_id,outbox.lease,denied(error)?"failed":"uncertain");}
 }
 }
 private requireResult(record:SlackPersonalRecord,result:SlackPersonalResult){if(result.requestingActorId!==record.envelope.ownerId||(record.acceptedKind==="run"&&result.runId&&result.runId!==record.acceptedId))throw new SlackCompanyError("forbidden");}
}
function denied(error:unknown){return error instanceof Error&&"code" in error&&["forbidden","not_found","conflict"].includes(String(error.code));}

/** Both submission and output reads verify the durable direct bot binding and personal Chat. */
async function requirePersonalChat(db:Kysely<OwnerBotDatabase>,record:SlackPersonalRecord){
 const envelope=SlackBridgeEnvelopeSchema.parse(record.envelope);
 if(envelope.actorId!==envelope.ownerId||envelope.event.kind!=="direct_message"||!envelope.event.channelId.startsWith("D")||envelope.channelScopeId!==undefined||envelope.companyPublicationApproved!==undefined)throw new SlackCompanyError("forbidden");
 const row=await db.selectFrom("chats as chat").innerJoin("bot_chat_bindings as binding","binding.chat_id","chat.id")
 .select(["chat.revision","chat.current_selection","chat.bound_driver_kind","chat.bound_instance_id","chat.collaboration"])
 .where("chat.id","=",record.chatId).where("chat.owner_type","=","personal").where("chat.owner_id","=",record.envelope.ownerId).where("chat.lifecycle","=","active")
 .where("binding.owner_id","=",record.envelope.ownerId).where("binding.bot_id","=",record.botId).where("binding.kind","=","direct").where("binding.removed_at","is",null).executeTakeFirst();
 if(!row||row.collaboration!==null||(row.bound_driver_kind!==null&&row.bound_driver_kind!=="matrix_bot")||(row.bound_instance_id!==null&&row.bound_instance_id!==MATRIX_BOT_INSTANCE_ID))throw new SlackCompanyError("forbidden");return row;
}
/** Routes personal Slack events through the same canonical matrix_bot queue and Pi adapter as Chat. */
export function createSlackPersonalSubmitter(input:{db:Kysely<OwnerBotDatabase>;orchestrator:Pick<CanonicalChatOrchestrator,"enqueueQueuedTurn"|"admitTurn">}){return async(record:SlackPersonalRecord)=>{
 const chat=await requirePersonalChat(input.db,record);
 const admitted=await input.db.selectFrom("chat_runs as run").innerJoin("chat_turns as turn","turn.id","run.turn_id").innerJoin("chat_messages as request","request.id","turn.input_message_id")
  .select(["run.id","run.driver_kind","run.instance_id","request.actor_id","request.parts"]).where("run.chat_id","=",record.chatId).where("run.client_request_id","=",record.clientRequestId).where("turn.chat_id","=",record.chatId).where("request.chat_id","=",record.chatId).executeTakeFirst();
 if(admitted){const parts=typeof admitted.parts==="string"?JSON.parse(admitted.parts):admitted.parts;if(admitted.driver_kind!=="matrix_bot"||admitted.instance_id!==MATRIX_BOT_INSTANCE_ID||admitted.actor_id!==record.envelope.ownerId||JSON.stringify(CanonicalChatMessageSchema.shape.parts.parse(parts))!==JSON.stringify(CanonicalChatMessageSchema.shape.parts.parse([{type:"text",text:record.text}])))throw new SlackCompanyError("conflict");return {runId:admitted.id};}
 const duplicate=await input.db.selectFrom("chat_queued_turns").select(["id","driver_kind","instance_id","parts","collaboration_scope_id"])
  .where("chat_id","=",record.chatId).where("client_request_id","=",record.clientRequestId).executeTakeFirst();
 if(duplicate){const parts=typeof duplicate.parts==="string"?JSON.parse(duplicate.parts):duplicate.parts;
  if(duplicate.collaboration_scope_id!==null||duplicate.driver_kind!=="matrix_bot"||duplicate.instance_id!==MATRIX_BOT_INSTANCE_ID||JSON.stringify(CanonicalChatMessageSchema.shape.parts.parse(parts))!==JSON.stringify(CanonicalChatMessageSchema.shape.parts.parse([{type:"text",text:record.text}])))throw new SlackCompanyError("conflict");return {queuedTurnId:duplicate.id};}
 const active=await input.db.selectFrom("chat_runs").select("id").where("chat_id","=",record.chatId).where("status","in",["accepted","running","waiting_for_input","waiting_for_approval"]).executeTakeFirst();
 const principal={userId:record.envelope.ownerId,source:"platform-verified" as const},owner={type:"personal" as const,ownerId:record.envelope.ownerId};
 const turn={clientRequestId:record.clientRequestId,baseRevision:Number(chat.revision),parts:[{type:"text" as const,text:record.text}],selection:MATRIX_BOT_SELECTION,interactionMode:"default",permissionMode:"supervised"};
 if(active){const response=await input.orchestrator.enqueueQueuedTurn(principal,owner,record.chatId,turn);return {queuedTurnId:response.queuedTurn.id};}
 const response=await input.orchestrator.admitTurn(principal,owner,record.chatId,turn);return {runId:response.run.id};
};}
/** Reads only the accepted queue/run's committed assistant text, with exact owner and actor fences. */
export function createSlackPersonalResultReader(db:Kysely<OwnerBotDatabase>){return async(record:SlackPersonalRecord):Promise<SlackPersonalResult>=>{
 await requirePersonalChat(db,record);if(!record.acceptedId||!record.acceptedKind)throw new SlackCompanyError("forbidden");
 let runId=record.acceptedId;
 if(record.acceptedKind==="queue"){
  const queued=await db.selectFrom("chat_queued_turns").select(["claimed_run_id","status","collaboration_scope_id","driver_kind","client_request_id"])
   .where("id","=",record.acceptedId).where("chat_id","=",record.chatId).executeTakeFirst();
  if(!queued||queued.collaboration_scope_id!==null||queued.driver_kind!=="matrix_bot"||queued.client_request_id!==record.clientRequestId)throw new SlackCompanyError("forbidden");
  if(!queued.claimed_run_id)return {status:["queued","claimed"].includes(queued.status)?"pending":"failed",requestingActorId:record.envelope.ownerId};runId=queued.claimed_run_id;
 }
 const run=await db.selectFrom("chat_runs as run").innerJoin("chat_turns as turn","turn.id","run.turn_id").innerJoin("chat_messages as request","request.id","turn.input_message_id")
  .select(["run.status","run.driver_kind","run.client_request_id","request.actor_id"])
  .where("run.id","=",runId).where("run.chat_id","=",record.chatId).where("turn.chat_id","=",record.chatId).where("request.chat_id","=",record.chatId).executeTakeFirst();
 if(!run||run.driver_kind!=="matrix_bot"||run.client_request_id!==record.clientRequestId||run.actor_id!==record.envelope.ownerId)throw new SlackCompanyError("forbidden");
 if(run.status!=="completed")return {status:["accepted","running","waiting_for_input","waiting_for_approval"].includes(run.status)?"pending":"failed",requestingActorId:run.actor_id,runId};
 const messages=await db.selectFrom("chat_messages").select(["parts"]).where("chat_id","=",record.chatId).where("run_id","=",runId).where("role","=","assistant").where("state","=","committed").orderBy("seq").limit(20).execute();
 const text=messages.flatMap(row=>CanonicalChatMessageSchema.shape.parts.parse(typeof row.parts==="string"?JSON.parse(row.parts):row.parts).flatMap(part=>part.type==="text"?[part.text]:[])).join("\n").slice(0,12_000);
 return {status:"completed",requestingActorId:run.actor_id,runId,text};
};}


/** Instantiation owns its recoverable file/DB workflow and runs before the mapping transaction. */
export function createSlackPersonalChatResolver(input:{ownerId:string;instantiation:Pick<BotInstantiation,"instantiate">}){
 function validate(request:{envelope:SlackBridgeEnvelope;dmKey:string}){
  if(request.envelope.ownerId!==input.ownerId||request.envelope.actorId!==input.ownerId||request.envelope.event.kind!=="direct_message"||!request.envelope.event.channelId.startsWith("D")||request.dmKey!==personalDmKey(request.envelope)||request.envelope.channelScopeId!==undefined||request.envelope.companyPublicationApproved!==undefined)throw new SlackCompanyError("forbidden");
 }
 return {
  async preparePersonalChat(request:{envelope:SlackBridgeEnvelope;dmKey:string}){
   validate(request);const response=await input.instantiation.instantiate(input.ownerId,{clientRequestId:`req_${personalDigest(["slack-personal",input.ownerId,request.dmKey])}`,recipe:{recipeId:"personal-assistant",version:"2026-09-30.1"},name:"Personal Assistant"});
   return {chatId:response.chatId,botId:response.agent.id};
  },
  async resolvePersonalChat(request:{envelope:SlackBridgeEnvelope;dmKey:string;prepared?:SlackPersonalConversation},trx:Transaction<SlackPersonalDatabase>){
   validate(request);if(!request.prepared)throw new SlackCompanyError("unavailable");
   await requirePersonalChat(trx as unknown as Kysely<OwnerBotDatabase>,{envelope:request.envelope,eventId:"setup",clientRequestId:"req_setup",...request.prepared,text:"setup"});
   return request.prepared;
  },
 };
}
