import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type ColumnType, type Selectable, type Transaction } from "kysely";
import type { SlackBridgeEnvelope } from "@matrix-os/contracts/slack-bridge";
import { SlackCompanyError } from "./schemas.js";
type Timestamp=ColumnType<Date|string,Date|string,Date|string>;
type NullableTime=ColumnType<Date|string|null,Date|string|null,Date|string|null>;
export interface SlackPersonalInboxTable {
 id:string;owner_id:string;dm_key:string;envelope:ColumnType<unknown,unknown,unknown>;payload_hash:string;
 state:"pending"|"processing"|"accepted"|"completed"|"failed";attempts:number;lease:string|null;lease_until:NullableTime;
 chat_id:string|null;bot_id:string|null;accepted_kind:"run"|"queue"|null;accepted_id:string|null;created_at:Timestamp;updated_at:Timestamp;
}
export interface SlackPersonalConversationsTable {dm_key:string;owner_id:string;chat_id:string;bot_id:string;updated_at:Timestamp}
export interface SlackPersonalOutboxTable {event_id:string;run_id:string;text:string;state:"pending"|"sending"|"sent"|"uncertain"|"failed";attempts:number;lease:string|null;lease_until:NullableTime;message_ts:string|null;updated_at:Timestamp}
export interface SlackPersonalDatabase {slack_personal_inbox:SlackPersonalInboxTable;slack_personal_conversations:SlackPersonalConversationsTable;slack_personal_outbox:SlackPersonalOutboxTable}
export type SlackPersonalInbox=Selectable<SlackPersonalInboxTable>;
export type SlackPersonalConversation={chatId:string;botId:string};
export const personalDigest=(input:unknown)=>createHash("sha256").update(JSON.stringify(input)).digest("hex");
export function personalEventId(envelope:SlackBridgeEnvelope){const hex=personalDigest([envelope.event.appId,envelope.event.teamId,envelope.event.eventId]);return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;}
export function personalDmKey(envelope:SlackBridgeEnvelope){return personalDigest([envelope.ownerId,envelope.event.appId,envelope.event.teamId,envelope.event.userId,envelope.event.channelId]);}
/** The caller owns the shared Postgres connection; no credentials are persisted here. */
export async function bootstrapSlackPersonalDatabase(db:Kysely<SlackPersonalDatabase>){await db.transaction().execute(async trx=>{
 await sql`SELECT pg_advisory_xact_lock(219784014)`.execute(trx);
 await sql`CREATE TABLE IF NOT EXISTS slack_personal_inbox(id uuid PRIMARY KEY,owner_id text NOT NULL,dm_key text NOT NULL,envelope jsonb NOT NULL,payload_hash text NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','processing','accepted','completed','failed')),attempts integer NOT NULL DEFAULT 0,lease uuid,lease_until timestamptz,
 chat_id text,bot_id text,accepted_kind text CHECK(accepted_kind IN ('run','queue')),accepted_id text,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL)`.execute(trx);
 await sql`CREATE INDEX IF NOT EXISTS slack_personal_inbox_work ON slack_personal_inbox(owner_id,state,updated_at)`.execute(trx);
 await sql`CREATE TABLE IF NOT EXISTS slack_personal_conversations(dm_key text PRIMARY KEY,owner_id text NOT NULL,chat_id text NOT NULL,bot_id text NOT NULL,updated_at timestamptz NOT NULL)`.execute(trx);
 await sql`CREATE TABLE IF NOT EXISTS slack_personal_outbox(event_id uuid PRIMARY KEY REFERENCES slack_personal_inbox(id) ON DELETE CASCADE,run_id text NOT NULL,text text NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','sending','sent','uncertain','failed')),attempts integer NOT NULL DEFAULT 0,lease uuid,lease_until timestamptz,message_ts text,updated_at timestamptz NOT NULL)`.execute(trx);
});}
export class SlackPersonalRepository {
 constructor(private readonly db:Kysely<SlackPersonalDatabase>,private readonly ownerId:string,private readonly now:()=>Date){}
 async receive(envelope:SlackBridgeEnvelope){return this.db.transaction().execute(async trx=>{
  await sql`SELECT pg_advisory_xact_lock(hashtext(${this.ownerId}))`.execute(trx);
  const id=personalEventId(envelope),hash=personalDigest(envelope);
  const old=await trx.selectFrom("slack_personal_inbox").selectAll().where("id","=",id).executeTakeFirst();
  if(old){if(old.owner_id!==this.ownerId||old.payload_hash!==hash)throw new SlackCompanyError("conflict");return {accepted:true as const,duplicate:true,eventId:id};}
  const count=await trx.selectFrom("slack_personal_inbox").select([sql<string>`count(*)`.as("total"),sql<string>`count(*) FILTER(WHERE state IN ('pending','processing','accepted'))`.as("pending")]).where("owner_id","=",this.ownerId).executeTakeFirstOrThrow();
  if(Number(count.total)>=10_000||Number(count.pending)>=1000)throw new SlackCompanyError("capacity");
  await trx.insertInto("slack_personal_inbox").values({id,owner_id:this.ownerId,dm_key:personalDmKey(envelope),envelope:sql`${JSON.stringify(envelope)}::jsonb`,payload_hash:hash,state:"pending",attempts:0,lease:null,lease_until:null,chat_id:null,bot_id:null,accepted_kind:null,accepted_id:null,created_at:this.now(),updated_at:this.now()}).onConflict(oc=>oc.column("id").doNothing()).execute();
  const stored=await trx.selectFrom("slack_personal_inbox").select(["owner_id","payload_hash"]).where("id","=",id).executeTakeFirstOrThrow();
  if(stored.owner_id!==this.ownerId||stored.payload_hash!==hash)throw new SlackCompanyError("conflict");
  return {accepted:true as const,duplicate:false,eventId:id};
 });}
 async conversation(dmKey:string){return this.db.selectFrom("slack_personal_conversations").selectAll().where("owner_id","=",this.ownerId).where("dm_key","=",dmKey).executeTakeFirst();}
 async claim(){return this.db.transaction().execute(async trx=>{
  await trx.updateTable("slack_personal_inbox").set({state:"failed",lease:null,lease_until:null,updated_at:this.now()}).where("owner_id","=",this.ownerId).where("state","=","processing").where("attempts",">=",8).where("lease_until","<",this.now()).execute();
  const row=await trx.selectFrom("slack_personal_inbox").selectAll().where("owner_id","=",this.ownerId).where("attempts","<",8)
   .where(eb=>eb.or([eb.and([eb("state","=","pending"),eb.or([eb("lease_until","is",null),eb("lease_until","<=",this.now())])]),eb.and([eb("state","=","processing"),eb("lease_until","<",this.now())])]))
   .orderBy("created_at").forUpdate().skipLocked().executeTakeFirst();
  if(!row)return null;
  return trx.updateTable("slack_personal_inbox").set({state:"processing",attempts:row.attempts+1,lease:randomUUID(),lease_until:new Date(this.now().getTime()+60_000),updated_at:this.now()}).where("id","=",row.id).returningAll().executeTakeFirstOrThrow();
 });}
 async bind(row:SlackPersonalInbox,resolve:(trx:Transaction<SlackPersonalDatabase>)=>Promise<SlackPersonalConversation>){return this.db.transaction().execute(async trx=>{
  await sql`SELECT pg_advisory_xact_lock(hashtext(${this.ownerId}))`.execute(trx);
  const current=await trx.selectFrom("slack_personal_inbox").selectAll().where("id","=",row.id).where("owner_id","=",this.ownerId).forUpdate().executeTakeFirstOrThrow();
  if(current.lease!==row.lease||current.state!=="processing")throw new SlackCompanyError("conflict");
  let old=await trx.selectFrom("slack_personal_conversations").selectAll().where("dm_key","=",row.dm_key).executeTakeFirst();
  if(old&&old.owner_id!==this.ownerId)throw new SlackCompanyError("forbidden");
  if(!old){
   const count=await trx.selectFrom("slack_personal_conversations").select(sql<string>`count(*)`.as("total")).where("owner_id","=",this.ownerId).executeTakeFirstOrThrow();
   if(Number(count.total)>=10_000)throw new SlackCompanyError("capacity");
   const binding=await resolve(trx);
   if(!/^chat_[A-Za-z0-9_.:-]{1,123}$/.test(binding.chatId)||!/^bot_[a-z0-9]{8,64}$/.test(binding.botId))throw new SlackCompanyError("forbidden");
   old=await trx.insertInto("slack_personal_conversations").values({dm_key:row.dm_key,owner_id:this.ownerId,chat_id:binding.chatId,bot_id:binding.botId,updated_at:this.now()}).onConflict(oc=>oc.column("dm_key").doNothing()).returningAll().executeTakeFirstOrThrow();
  }
  if(current.chat_id&&(current.chat_id!==old.chat_id||current.bot_id!==old.bot_id))throw new SlackCompanyError("conflict");
  return trx.updateTable("slack_personal_inbox").set({chat_id:old.chat_id,bot_id:old.bot_id,updated_at:this.now()}).where("id","=",row.id).where("lease","=",row.lease).returningAll().executeTakeFirstOrThrow();
 });}
 async accepted(row:SlackPersonalInbox,input:{kind:"run"|"queue";id:string}){await this.db.updateTable("slack_personal_inbox").set({state:"accepted",accepted_kind:input.kind,accepted_id:input.id,lease:null,lease_until:null,updated_at:this.now()}).where("id","=",row.id).where("owner_id","=",this.ownerId).where("lease","=",row.lease).execute();}
 async release(row:SlackPersonalInbox,retry:boolean){await this.db.updateTable("slack_personal_inbox").set({state:retry&&row.attempts<8?"pending":"failed",lease:null,lease_until:retry?new Date(this.now().getTime()+Math.min(300_000,5000*2**row.attempts)):null,updated_at:this.now()}).where("id","=",row.id).where("owner_id","=",this.ownerId).where("lease","=",row.lease).execute();}
 async waiting(){return this.db.selectFrom("slack_personal_inbox").selectAll().where("owner_id","=",this.ownerId).where("state","=","accepted").orderBy("updated_at").limit(20).execute();}
 async deferResult(row:SlackPersonalInbox){await this.db.updateTable("slack_personal_inbox").set({updated_at:this.now()})
  .where("id","=",row.id).where("owner_id","=",this.ownerId).where("state","=","accepted").where("accepted_id","=",row.accepted_id).where("accepted_kind","=",row.accepted_kind).execute();}
 async finish(row:SlackPersonalInbox,result:{runId:string;text:string}|null){await this.db.transaction().execute(async trx=>{
  const current=await trx.selectFrom("slack_personal_inbox").selectAll().where("id","=",row.id).where("owner_id","=",this.ownerId).forUpdate().executeTakeFirst();
  if(!current||current.state!=="accepted"||current.accepted_id!==row.accepted_id)return;
  if(result)await trx.insertInto("slack_personal_outbox").values({event_id:row.id,run_id:result.runId,text:result.text,state:"pending",attempts:0,lease:null,lease_until:null,message_ts:null,updated_at:this.now()}).onConflict(oc=>oc.column("event_id").doNothing()).execute();
  await trx.updateTable("slack_personal_inbox").set({state:result?"completed":"failed",updated_at:this.now()}).where("id","=",row.id).execute();
 });}
 async claimReply(){return this.db.transaction().execute(async trx=>{
  await trx.updateTable("slack_personal_outbox").set({state:"uncertain",lease:null,lease_until:null,updated_at:this.now()}).where("event_id","in",trx.selectFrom("slack_personal_inbox").select("id").where("owner_id","=",this.ownerId)).where("state","=","sending").where("lease_until","<",this.now()).execute();
  const row=await trx.selectFrom("slack_personal_outbox as outbox").innerJoin("slack_personal_inbox as inbox","inbox.id","outbox.event_id").selectAll("outbox").where("inbox.owner_id","=",this.ownerId).where("outbox.state","=","pending").where("outbox.attempts","<",3).where(eb=>eb.or([eb("outbox.lease_until","is",null),eb("outbox.lease_until","<=",this.now())])).orderBy("outbox.updated_at").forUpdate("outbox").skipLocked().executeTakeFirst();
  if(!row)return null;
  const outbox=await trx.updateTable("slack_personal_outbox").set({state:"sending",attempts:row.attempts+1,lease:randomUUID(),lease_until:new Date(this.now().getTime()+30_000),updated_at:this.now()}).where("event_id","=",row.event_id).returningAll().executeTakeFirstOrThrow();
  return {outbox,inbox:await trx.selectFrom("slack_personal_inbox").selectAll().where("id","=",row.event_id).executeTakeFirstOrThrow()};
 });}
 async replyStatus(id:string,lease:string|null,state:SlackPersonalOutboxTable["state"],messageTs?:string){await this.db.updateTable("slack_personal_outbox").set({state,lease:null,lease_until:state==="pending"?new Date(this.now().getTime()+30_000):null,message_ts:messageTs??null,updated_at:this.now()}).where("event_id","=",id).where("lease","=",lease).execute();}
 /** Retain ambiguous outcomes for review for 30 days, then expire without retrying. */
 async cleanup(){
  const cutoff=new Date(this.now().getTime()-30*86400_000);
  await this.db.deleteFrom("slack_personal_inbox").where("owner_id","=",this.ownerId).where("state","in",["completed","failed"])
   .where("updated_at","<",cutoff).where("id","not in",this.db.selectFrom("slack_personal_outbox").select("event_id")
    .where(eb=>eb.or([eb("state","in",["pending","sending"]),eb.and([eb("state","=","uncertain"),eb("updated_at",">=",cutoff)])]))).execute();
 }
}
