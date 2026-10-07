import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import { createCustomBotChats } from "../../../packages/gateway/src/bots/custom-direct-chat.js";
import { createRealBotStateDatabase, OWNER } from "./bot-state-support.js";

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("custom Bot pooled owner-lock concurrency", () => {
 let repository: ChatRepository, agents: ChatAgentStore, home: string, destroy: () => Promise<void>;
 const owner = { type: "personal" as const, ownerId: OWNER };
 beforeEach(async () => { const state = await createRealBotStateDatabase(); destroy = state.destroy;
  repository = new ChatRepository(state.db as unknown as Kysely<ChatDatabase>); home = await mkdtemp(join(tmpdir(), "matrix-custom-concurrency-"));
  agents = new ChatAgentStore({ homePath: home, db: repository.kysely }); await agents.bootstrap();
 });
 afterEach(async()=>{await agents.close();await destroy();await rm(home,{recursive:true,force:true});});
 const create = () => agents.create(owner,{clientRequestId:"req_custom",name:"Same name",description:"",instructions:"Read only",selection:{instanceId:"codex_default",model:"gpt-5.6-sol"}});
 it("coalesces twelve opens across pooled transactions into one canonical Chat, binding and committed event",async()=>{
  const bot = await create(); const service = createCustomBotChats({chats:repository,agents});
  const ids = await Promise.all(Array.from({length:12},()=>service.ensureDirectChat(owner,bot.id)));
  expect(new Set(ids).size).toBe(1);
  expect(await repository.kysely.selectFrom("chats").selectAll().execute()).toHaveLength(1);
  const events = await repository.kysely.selectFrom("chat_outbox").selectAll().execute();
  expect(events.filter(event=>event.event_type==="bot.created")).toHaveLength(1);
 });
 it("serializes archive against an in-flight identity adaptation on the same owner lock",async()=>{
  const bot = await create(); let release!:()=>void, entered!:()=>void;
  const hold = new Promise<void>(resolve=>{release=resolve;}); const locked = new Promise<void>(resolve=>{entered=resolve;});
  const service = createCustomBotChats({chats:repository,agents:{get:async(actor,id)=>{entered();await hold;return agents.get(actor,id);}}});
  const opening = service.ensureDirectChat(owner,bot.id); await locked;
  let archived = false; const archive = agents.update(owner,bot.id,{baseRevision:1,archived:true}).then(value=>{archived=true;return value;});
  await new Promise(resolve=>setTimeout(resolve,50));expect(archived).toBe(false);
  release(); const chatId = await opening; await archive;
  expect((await repository.get(owner,chatId))?.chat.lifecycle).toBe("active");
  await expect(createCustomBotChats({chats:repository,agents}).ensureDirectChat(owner,bot.id)).rejects.toMatchObject({code:"not_found"});
 });
});
