import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotSchemaError, bootstrapBotDatabase, type OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { BOT_MIGRATIONS } from "../../../packages/gateway/src/bots/database-migrations.js";
import { migrateChatGptPlanDevices } from "../../../packages/gateway/src/bots/chatgpt-plan-device-migration.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotGrantsRepository } from "../../../packages/gateway/src/bots/repositories/grants.js";
import { createBotRoutes } from "../../../packages/gateway/src/bots/routes.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { startBots, type BotServices } from "../../../packages/gateway/src/startup/bots.js";
import { BOT, NOW, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";
import { migrateDeployedProviderConnectionsV5 } from "./fixtures/provider-schema-v5.js";
import { DEPLOYED_DEVICE_PINS_V6_SQL, migrateDeployedChatGptPlanDevicesV6 } from "./fixtures/provider-schema-v6.js";

const deployed = [...BOT_MIGRATIONS.slice(0, 4),
  { version: 5, name: "bot_provider_connections", up: migrateDeployedProviderConnectionsV5 },
  { version: 6, name: "bot_chatgpt_plan_devices", up: migrateDeployedChatGptPlanDevicesV6 }];
let db: Kysely<OwnerBotDatabase>, destroy: () => Promise<void>;
let home: string, agents: ChatAgentStore, repository: ChatRepository, services: BotServices | undefined;
beforeEach(async () => {
  ({db, destroy} = await createBotStateDatabase({migrate:false}));
  home = await mkdtemp(join(tmpdir(), "matrix-deployed-v6-"));
  repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  agents = new ChatAgentStore({homePath:home,db:repository.kysely});
  await agents.bootstrap();
});
afterEach(async () => { await services?.close(); services=undefined; await agents.close(); await destroy(); await rm(home,{recursive:true,force:true}); });
async function rows(table: string) { return (await sql`SELECT * FROM ${sql.table(table)} ORDER BY 1, 2`.execute(db)).rows; }

it("executes exactly the frozen released v6 DDL from the production migration", async () => {
  const statements: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const traced = db.withPlugin({
    transformQuery({ node, queryId }) {
      const query = db.getExecutor().compileQuery(node, queryId);
      statements.push({ sql: query.sql, parameters: query.parameters });
      return node;
    },
    async transformResult({ result }) { return result; },
  });
  await traced.transaction().execute(migrateChatGptPlanDevices);
  expect(statements).toEqual([{ sql: DEPLOYED_DEVICE_PINS_V6_SQL, parameters: [] }]);
});

it("restores Bot startup from exact deployed v6 while preserving every trust pin, grant, binding, definition and historical message", async () => {
  expect(Buffer.byteLength(DEPLOYED_DEVICE_PINS_V6_SQL)).toBe(366);
  expect(createHash("sha256").update(DEPLOYED_DEVICE_PINS_V6_SQL).digest("hex")).toBe("511b94401e667289f625610965219b02f1df4d1bc6c4c29edc7e7c24ea2b1122");
  await bootstrapBotDatabase(db,deployed);
  await insertChat(db,"chat_existing_v6");
  await db.insertInto("chat_messages").values({id:"msg_historical_v6",chat_id:"chat_existing_v6",seq:1,role:"user",purpose:"discussion",state:"committed",turn_id:null,run_id:null,actor_id:OWNER,parts:[{type:"text",text:"Existing owner history"}],byte_count:22,search_text:"Existing owner history",created_at:NOW}).execute();
  const owner={type:"personal" as const,ownerId:OWNER};
  await agents.createRecipeBot(owner,{id:BOT,createHash:"a".repeat(64),fields:{name:"Saved writer",description:"",instructions:"Help write.",selection:{instanceId:"matrix_pi_default",model:"sonnet"}},recipeRef:{recipeId:"writing-bot",version:"2026-09-27.1"}});
  await createBotBindingsRepository(db).bindDirect({ownerId:OWNER,botId:BOT,chatId:"chat_existing_v6",now:NOW});
  await createBotGrantsRepository(db).grant({ownerId:OWNER,botId:BOT,service:"gmail",connectionId:"conn_saved",accountLabel:"Owner account",effects:["read"],audience:"direct",grantedByActorId:OWNER,now:NOW});
  await sql`INSERT INTO bot_provider_authorizations VALUES (${OWNER}, 'computer_saved', 'claude_code_tasks', 'retained-fingerprint', true, false, 7)`.execute(db);
  await sql`INSERT INTO bot_execution_bindings VALUES (${OWNER}, 'computer_saved', ${BOT}, 'claude_code_tasks', 'sonnet', 7, 'native_saved', 4)`.execute(db);
  for (const [ownerId, computerId, device] of [[OWNER,"computer_saved","a"],[OWNER,"computer_other","b"],["other_owner","computer_saved","c"]]) {
    await sql`INSERT INTO bot_chatgpt_plan_devices VALUES (${ownerId}, ${computerId}, ${device.repeat(64)}, ${"fixture-public-key-"+device.repeat(32)})`.execute(db);
  }
  const tables=["bot_chatgpt_plan_devices","bot_provider_authorizations","bot_execution_bindings","bot_grants","bot_chat_bindings","chats","chat_messages"];
  const before=await Promise.all(tables.map(rows));
  const file=join(home,"agents/custom/chat-bots",createHash("sha256").update(`personal:${OWNER}`).digest("hex"),`${BOT}.md`), definition=await readFile(file);
  services=await startBots({homePath:home,repository,agents,executionRoots:{resolve:vi.fn()},providers:{getSnapshot:vi.fn()}});
  const app=new Hono().route("/",createBotRoutes({...(services?{botChats:services.botChats,recipes:services.recipes}:{}),getPrincipal:()=>({userId:OWNER,handle:"fixture-owner"})}));
  const response=await app.request(`/api/chat-agents/${BOT}/direct-chat`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({chatId:"chat_existing_v6"});
  expect((await app.request("/api/chats/chat_existing_v6/bot")).status).toBe(200);
  await expect(bootstrapBotDatabase(db)).resolves.toEqual({applied:[]});
  expect(await Promise.all(tables.map(rows))).toEqual(before);
  expect(await readFile(file)).toEqual(definition);
});

it.each([[6,"wrong_device_feature","invalid_migrations"],[7,"unknown_future","newer_schema"]] as const)("rejects recorded version %i named %s before any pending DDL", async (version,name,code) => {
  await bootstrapBotDatabase(db,[BOT_MIGRATIONS[0]!]);
  await sql`INSERT INTO bot_schema_migrations (version,name) VALUES (${version},${name})`.execute(db);
  const before=await rows("bot_schema_migrations");
  await expect(bootstrapBotDatabase(db)).rejects.toEqual(new BotSchemaError(code));
  expect(await rows("bot_schema_migrations")).toEqual(before);
  const tables=await sql<{table_name:string}>`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('bot_provider_authorizations','bot_chatgpt_plan_devices','managed_pi_sessions')`.execute(db);
  expect(tables.rows).toEqual([]);
});

it("applies released v6 on a fresh owner and preserves its device constraints on repeated startup", async () => {
  await expect(bootstrapBotDatabase(db)).resolves.toEqual({applied:[1,2,3,4,5,6]});
  await expect(bootstrapBotDatabase(db)).resolves.toEqual({applied:[]});
  await sql`INSERT INTO bot_chatgpt_plan_devices VALUES (${OWNER}, 'computer_new', ${"d".repeat(64)}, ${"valid-public-key".repeat(3)})`.execute(db);
  await expect(sql`INSERT INTO bot_chatgpt_plan_devices VALUES (${OWNER}, 'computer_bad', 'INVALID_DEVICE', ${"valid-public-key".repeat(3)})`.execute(db)).rejects.toThrow();
  await expect(sql`INSERT INTO bot_chatgpt_plan_devices VALUES (${OWNER}, 'computer_short', ${"e".repeat(64)}, 'short')`.execute(db)).rejects.toThrow();
  await expect(sql`INSERT INTO bot_chatgpt_plan_devices VALUES (${OWNER}, 'computer_new', ${"f".repeat(64)}, ${"other-public-key".repeat(3)})`.execute(db)).rejects.toThrow();
  expect(await rows("bot_chatgpt_plan_devices")).toHaveLength(1);
});
