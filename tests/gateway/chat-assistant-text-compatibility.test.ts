import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { z } from "zod/v4";
import { CanonicalChatAssistantTextPartSchema, CanonicalChatTransportFrameSchema, CanonicalProviderCatalogSchema, chatMessageVersionUrl, CanonicalChatMessagePartSchema } from "@matrix-os/contracts";
import { ReleasedChatTextPartSchema } from "../fixtures/desktop-v0.1.19/chat-message-text-part";
import { createTestPGlite } from "../helpers/pglite-test-helper";
import { ChatRepository } from "../../packages/gateway/src/chat/repository";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../packages/gateway/src/chat/provider-adapter";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service";
import { createCanonicalChatRoutes } from "../../packages/gateway/src/chat/routes";
import { registerCanonicalChatEventHttpRoute } from "../../packages/gateway/src/chat/event-http-route";

const owner={type:"personal" as const,ownerId:"owner_text_compatibility"};
let repository:ChatRepository;
beforeAll(async()=>{const pg=await createTestPGlite();repository=new ChatRepository(pg.dialect);await repository.bootstrap();});
afterAll(async()=>{await repository.kysely.destroy();});

it.each(["kernel","matrix_pi"] as const)("reads %s output across released and capable clients without changing owner data",async driverKind=>{
 const id=`chat_text_${driverKind}`;
 const instanceId=`test_${driverKind}`;
 const catalog=CanonicalProviderCatalogSchema.parse({revision:"text_test",drivers:[{kind:driverKind,displayName:"Synthetic",adapterVersion:"1.0.0",capabilityClass:"coding_agent"}],instances:[{
  id:instanceId,driverKind,displayName:"Synthetic",availability:"available",workspaceRequirement:"project_optional",catalogRevision:"text_test",
  models:[{id:"synthetic-model",displayName:"Synthetic",availability:"available",capabilities:["tools"],supportsVision:false,supportsToolUse:true}],options:[],skills:[],commands:[],setupActions:[],
  supports:{rootChat:true,resume:false,cancellation:true,steering:"none",attachments:["file"],tools:[],approvals:true,userInput:true,worktrees:"none",resources:[],interactionModes:["default"],permissionModes:["supervised"]},
 }]});
 const adapter:CanonicalChatProviderAdapter={driverKind,stateSchemaVersion:1,parseState:v=>v,serializeState:v=>v,
  async *start(){for(let index=0;index<8;index++)yield{type:"assistant.delta",delta:"x".repeat(4_000)};yield{type:"assistant.delta",delta:"\n\n\n"};yield{type:"run.completed",outcome:"completed"};},async cancel(){}};
 await repository.create(owner,{id,clientRequestId:`req_${id}`,title:"Synthetic compatibility"});
 const orchestrator=new CanonicalChatOrchestrator({repository,catalog:{getCatalog:async()=>catalog},adapters:new CanonicalChatProviderRegistry([adapter])});
 await orchestrator.admitTurn({userId:owner.ownerId,source:"jwt"},owner,id,{clientRequestId:`req_turn_${id}`,baseRevision:0,parts:[{type:"text",text:"Synthetic"}],selection:{instanceId,model:"synthetic-model"},interactionMode:"default",permissionMode:"supervised"});
 await orchestrator.drain();
 const rawBefore=JSON.stringify(await repository.exportChat(owner,id));
 const service=createCanonicalChatService(repository);
 const app=new Hono().route("/",createCanonicalChatRoutes({service,getPrincipal:()=>({userId:owner.ownerId,source:"jwt"})}));
 const legacyResponse=await app.request(`/api/chats/${id}?messageVersion=2`);
 expect(legacyResponse.status).toBe(200);
 const legacy=await legacyResponse.json();
 const currentResponse=await app.request(chatMessageVersionUrl(`/api/chats/${id}`));
 expect(currentResponse.status).toBe(200);
 const current=await currentResponse.json();
 const legacyAssistant=legacy.messages.find((m:{role:string})=>m.role==="assistant");
 const currentAssistant=current.messages.find((m:{role:string})=>m.role==="assistant");
 expect(legacyAssistant.id).toBe(currentAssistant.id);
 expect(legacyAssistant.seq).toBe(currentAssistant.seq);
 expect(legacy.record).toEqual(current.record);
 expect(legacyAssistant.parts.every((part:unknown)=>ReleasedChatTextPartSchema.safeParse(part).success)).toBe(true);
 expect(legacyAssistant.parts.map((part:{text:string})=>part.text).join("")).toBe("x".repeat(32_000)+"\n\n\n");
 expect(currentAssistant.parts.at(-1)).toEqual({type:"text",text:"\n\n\n"});
 expect(currentAssistant.parts.some((part:unknown)=>!CanonicalChatMessagePartSchema.safeParse(part).success)).toBe(true);
 expect(JSON.stringify(await repository.exportChat(owner,id))).toBe(rawBefore);

 const frame=CanonicalChatTransportFrameSchema.parse({type:"chat.content",event:{cursor:7,chatId:id,revision:current.record.chat.revision,eventType:"run.completed",createdAt:current.record.chat.updatedAt},content:current});
 const events=new Hono();
 registerCanonicalChatEventHttpRoute({app:events,getPrincipal:()=>({userId:owner.ownerId,source:"jwt"}),stream:{open:async({sink})=>{sink.send(frame);return{onClose(){},touch(){}};}},setIntervalFn:vi.fn(()=>1),clearIntervalFn:vi.fn()});
 for(const opted of [false,true]){
  const response=await events.request(opted?chatMessageVersionUrl("/api/chats/events"):"/api/chats/events?messageVersion=2",{headers:{accept:"text/event-stream","x-matrix-chat-protocol":"2"}});
  const reader=response.body!.getReader();
  try{
   const text=new TextDecoder().decode((await reader.read()).value);
   const projected=JSON.parse(text.split("data: ")[1]!.split("\n\n")[0]!);
   expect(projected.event).toEqual(frame.event);
   if(opted)expect(projected.content.messages).toEqual(current.messages);
   else expect(projected).toEqual({type:"chat.event",event:frame.event});
  }finally{await reader.cancel();}
 }
});

it.each(["assistantTextVersion=yes","assistantTextVersion=1&assistantTextVersion=1"])("rejects invalid capability before reads or admission: %s",async query=>{
 const service=createCanonicalChatService(repository);
 const detail=vi.spyOn(service,"getDetail");
 const admission=vi.spyOn(service,"admitTurn");
 const app=new Hono().route("/",createCanonicalChatRoutes({service,getPrincipal:()=>({userId:owner.ownerId,source:"jwt"})}));
 expect((await app.request(`/api/chats/chat_missing?${query}`)).status).toBe(400);
 expect((await app.request(`/api/chats/chat_missing/turns?${query}`,{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status).toBe(400);
 expect(detail).not.toHaveBeenCalled();expect(admission).not.toHaveBeenCalled();
 const events=new Hono();const open=vi.fn();
 registerCanonicalChatEventHttpRoute({app:events,getPrincipal:()=>({userId:owner.ownerId,source:"jwt"}),stream:{open}});
 expect((await events.request(`/api/chats/events?${query}`,{headers:{accept:"text/event-stream"}})).status).toBe(400);
 expect(open).not.toHaveBeenCalled();
});

// Zod4.6.7 (the lockfile runtime) counts code points in .max(); a previous
// writer could therefore persist 20,000 emoji as one 40,000-UTF16-unit part.
// Zod4.4.3 cannot produce that historical shape; the exact-runtime qualification
// lane executes this case with 4.6.7 instead of inventing a migration fixture.
const historicalAstralText = "🧪".repeat(20_000);
it("preserves historical astral assistant rows on detail and raw export",async()=>{
 expect(z.string().max(32_000).safeParse(historicalAstralText).success, "This regression requires the lockfile Zod4.6.7 runtime").toBe(true);
 const id="chat_historical_astral";
 const part={type:"text" as const,text:historicalAstralText};
 expect(part.text.length).toBe(40_000);
 expect(new TextEncoder().encode(part.text).byteLength).toBe(80_000);
 expect(CanonicalChatAssistantTextPartSchema.safeParse(part).success).toBe(true);
 await repository.create(owner,{id,clientRequestId:"req_historical_astral",title:"Historical output"});
 await repository.kysely.transaction().execute(async trx=>{
  await trx.insertInto("chat_messages").values({id:"msg_historical_astral",chat_id:id,seq:1,role:"assistant",state:"committed",turn_id:null,run_id:null,actor_id:null,purpose:"assistant",parts:JSON.stringify([part]),byte_count:Buffer.byteLength(JSON.stringify([part])),search_text:"historical",created_at:new Date("2026-10-29T00:00:00.000Z")}).execute();
  await trx.updateTable("chats").set({message_count:1,revision:1}).where("id","=",id).execute();
 });
 const app=new Hono().route("/",createCanonicalChatRoutes({service:createCanonicalChatService(repository),getPrincipal:()=>({userId:owner.ownerId,source:"jwt"})}));
 for(const opted of [false,true]){
  const response=await app.request(opted?chatMessageVersionUrl(`/api/chats/${id}`):`/api/chats/${id}?messageVersion=2`);
  expect(response.status).toBe(200);
  const detail=await response.json();
  const message=detail.messages[0];
  expect(message.id).toBe("msg_historical_astral");
  expect(message.parts.map((item:{text:string})=>item.text).join("")).toBe(part.text);
  if(!opted)expect(message.parts.every((item:unknown)=>ReleasedChatTextPartSchema.safeParse(item).success)).toBe(true);
 }
 const exported=await repository.exportChat(owner,id);
 expect(exported!.messages[0]!.parts).toEqual([part]);
 expect(exported!.messages[0]!.id).toBe("msg_historical_astral");
});
