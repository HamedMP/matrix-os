import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotSchemaError, bootstrapBotDatabase, type OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { BOT_MIGRATIONS } from "../../../packages/gateway/src/bots/database-migrations.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { BotEntryError, createCustomBotChats } from "../../../packages/gateway/src/bots/custom-direct-chat.js";
import { createBotRoutes } from "../../../packages/gateway/src/bots/routes.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import { ChatAgentContext } from "../../../packages/gateway/src/chat/agent-context.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { CanonicalChatProviderRegistry } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { admitCanonicalTurn } from "../../../packages/gateway/src/chat/turn-admission.js";
import { createCanonicalChatRoutes, type CanonicalChatRouteService } from "../../../packages/gateway/src/chat/routes.js";
import { managedPiChatInstances } from "../../../packages/gateway/src/chat/managed-chat-catalog.js";
import { startBots, type BotServices } from "../../../packages/gateway/src/startup/bots.js";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import { BOT, NOW, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";
import { DEPLOYED_BOT_THREADS_V9_SQL, migrateDeployedBotThreadsV9 } from "./fixtures/bot-threads-schema-v9.js";

const owner = { type: "personal" as const, ownerId: OWNER };
const deployedV9 = [...BOT_MIGRATIONS.slice(0, 8), { version: 9, name: "bot_chat_threads", up: migrateDeployedBotThreadsV9 }];
let db: Kysely<OwnerBotDatabase>, destroy: () => Promise<void>, home: string;
let agents: ChatAgentStore, repository: ChatRepository, services: BotServices | undefined;
beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase({ migrate: false }));
  home = await mkdtemp(join(tmpdir(), "matrix-deployed-v9-"));
  repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  agents = new ChatAgentStore({ homePath: home, db: repository.kysely }); await agents.bootstrap();
});
afterEach(async () => { await services?.close(); services = undefined; await agents.close(); await destroy(); await rm(home, { recursive: true, force: true }); vi.restoreAllMocks(); });
const rows = async (table: string) => (await sql`SELECT * FROM ${sql.table(table)} ORDER BY 1, 2`.execute(db)).rows;

it("registers the exact five released v9 statements without changing their constraints", async () => {
  expect(createHash("sha256").update(JSON.stringify(DEPLOYED_BOT_THREADS_V9_SQL)).digest("hex"))
    .toBe("87035ccdef5ef36e7b5fe000c9873f5fc35b47618b669ad47aac270916190c99");
  await bootstrapBotDatabase(db, BOT_MIGRATIONS.slice(0, 8));
  const migration = BOT_MIGRATIONS.find(item => item.version === 9);
  expect(migration?.name).toBe("bot_chat_threads");
  const statements: Array<{ sql: string; parameters: readonly unknown[] }> = [];
  const traced = db.withPlugin({
    transformQuery({ node, queryId }) { const query = db.getExecutor().compileQuery(node, queryId); statements.push({ sql: query.sql, parameters: query.parameters }); return node; },
    async transformResult({ result }) { return result; },
  });
  await traced.transaction().execute(migration!.up);
  expect(statements).toEqual(DEPLOYED_BOT_THREADS_V9_SQL.map(statement => ({ sql: statement, parameters: [] })));
});

it("starts the managed Pi adapter over exact deployed v9 and preserves dormant thread projects, definitions and history", async () => {
  await bootstrapBotDatabase(db, deployedV9);
  await insertChat(db, "chat_saved_thread"); await insertChat(db, "chat_saved_direct");
  await db.insertInto("chat_messages").values({ id: "msg_saved_thread", chat_id: "chat_saved_thread", seq: 1,
    role: "user", purpose: "discussion", state: "committed", turn_id: null, run_id: null, actor_id: OWNER,
    parts: [{ type: "text", text: "Keep thread history" }], byte_count: 19, search_text: "Keep thread history", created_at: NOW }).execute();
  const agent = await agents.createRecipeBot(owner, { id: BOT, createHash: "a".repeat(64),
    fields: { name: "Saved writer", description: "", instructions: "Keep instructions.", selection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" } },
    recipeRef: { recipeId: "writing-bot", version: "2026-09-27.1" } });
  await sql`INSERT INTO bot_chat_bindings(owner_id,bot_id,chat_id,kind,project_id,created_at)
    VALUES (${OWNER},${BOT},'chat_saved_thread','thread','proj_saved',${NOW})`.execute(db);
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_saved_direct", now: NOW });
  const tables = ["bot_chat_bindings", "chats", "chat_messages", "bot_schema_migrations"];
  const before = await Promise.all(tables.map(rows));
  const definition = join(home, "agents/custom/chat-bots", createHash("sha256").update(`personal:${OWNER}`).digest("hex"), `${BOT}.md`);
  const bytes = await readFile(definition);
  const snapshot = makeAiProviderSnapshot(); const runBot = vi.fn(); const createRuntime = vi.fn();
  const host = { available: true, registerAuthorizer: vi.fn(() => vi.fn()), client: { runBot, createRuntime, stopRuntime: vi.fn() } } as unknown as ScopeRuntimeHost;
  services = await startBots({ homePath: home, repository, agents, executionRoots: { resolve: vi.fn() }, providers: { getSnapshot: async () => snapshot }, host });
  expect(services?.managedAdapter).toBeDefined();
  const registry = new CanonicalChatProviderRegistry([services!.managedAdapter!]);
  expect(registry.get("matrix_pi")).toBe(services!.managedAdapter);
  expect(managedPiChatInstances(snapshot)[0]).toMatchObject({ id: "matrix_pi_default", availability: "available", connectionState: "ready" });
  await expect(bootstrapBotDatabase(db)).resolves.toEqual({ applied: [] });
  const thread = await createBotBindingsRepository(db).forChat({ ownerId: OWNER, chatId: "chat_saved_thread" });
  expect(thread).toMatchObject([{ kind: "thread", projectId: "proj_saved" }]);
  expect(await services!.botChats.directChat!(owner, BOT)).toBe("chat_saved_direct");
  expect(await services!.botChats.directBot(owner, "chat_saved_direct")).toBe(BOT);
  expect((await repository.get(owner, "chat_saved_thread"))?.chat.id).toBe("chat_saved_thread");
  expect(await agents.get(owner, BOT)).toEqual(agent);
  expect(await readFile(definition)).toEqual(bytes);
  expect(await Promise.all(tables.map(rows))).toEqual(before);
  const botChats = createCustomBotChats({ chats: repository, agents });
  await expect(botChats.directBot(owner, "chat_saved_thread")).rejects.toEqual(new BotEntryError("unavailable"));
  const readHistory = vi.spyOn(repository, "getDetailPage");
  const context = new ChatAgentContext({ repository, agents, enabled: () => true, botChats });
  await expect(context.prepare(owner, "chat_saved_thread", { clientRequestId: "req_thread_dormant", baseRevision: 0,
    parts: [{ type: "text", text: "Do not execute" }], selection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" },
    interactionMode: "default", permissionMode: "supervised" })).rejects.toEqual(new BotEntryError("unavailable"));
  expect(readHistory).not.toHaveBeenCalled(); expect(createRuntime).not.toHaveBeenCalled(); expect(runBot).not.toHaveBeenCalled();
  const app = new Hono().route("/", createBotRoutes({ botChats, getPrincipal: () => ({ userId: OWNER, source: "jwt" }) as never }));
  expect((await app.request("/api/chats/chat_saved_thread/bot")).status).toBe(503);
  const getCatalog = vi.fn(async () => { throw new Error("Dormant thread must fail before catalog"); });
  const startDispatch = vi.fn(), persist = vi.spyOn(repository, "admitTurn");
  const service = { admitTurn: (principal, resolvedOwner, chatId, input) => admitCanonicalTurn({
    repository, agentContext: context, catalog: { getCatalog }, adapters: registry,
    assertOpen: () => {}, assertPersonalExecutionAllowed: async () => {}, reconcileActiveRuns: async () => {},
    reservePendingDispatch: () => {}, releasePendingDispatch: () => {}, atCapacity: () => false,
    hasStoppingExecution: () => false, startDispatch,
  }, principal, resolvedOwner, chatId, input) } as CanonicalChatRouteService;
  const chatApp = new Hono().route("/", createCanonicalChatRoutes({ service, getPrincipal: () => ({ userId: OWNER, source: "jwt" }) }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const response = await chatApp.request("/api/chats/chat_saved_thread/turns", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId: "req_dormant_http", baseRevision: 0, parts: [{ type: "text", text: "Do not execute" }],
      selection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" }, interactionMode: "default", permissionMode: "supervised" }) });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { code: "service_unavailable", safeMessage: "Chat is temporarily unavailable.", retryable: true, recoveryActions: ["retry"] } });
  expect(getCatalog).not.toHaveBeenCalled(); expect(startDispatch).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
  expect(await Promise.all(tables.map(rows))).toEqual(before);
});

it("upgrades clean v8 exactly once and retains direct/group behavior and v9 project constraints", async () => {
  await bootstrapBotDatabase(db, BOT_MIGRATIONS.slice(0, 8));
  await insertChat(db, "chat_v8_direct"); await insertChat(db, "chat_v8_group");
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: "chat_v8_direct", now: NOW });
  await sql`INSERT INTO bot_chat_bindings(owner_id,bot_id,chat_id,kind,created_at) VALUES (${OWNER},${BOT},'chat_v8_group','group',${NOW})`.execute(db);
  await expect(bootstrapBotDatabase(db)).resolves.toEqual({ applied: [9] });
  await expect(bootstrapBotDatabase(db)).resolves.toEqual({ applied: [] });
  expect(await createBotBindingsRepository(db).forChat({ ownerId: OWNER, chatId: "chat_v8_direct" })).toMatchObject([{ kind: "direct", projectId: null }]);
  expect(await createBotBindingsRepository(db).forChat({ ownerId: OWNER, chatId: "chat_v8_group" })).toMatchObject([{ kind: "group", projectId: null }]);
  await expect(sql`UPDATE bot_chat_bindings SET project_id='proj_wrong' WHERE kind='direct'`.execute(db)).rejects.toThrow();
});

it("blocks a retained thread even when it is beyond the bounded binding-history page", async () => {
  await bootstrapBotDatabase(db, deployedV9); await insertChat(db, "chat_many_bindings");
  for (let index = 0; index < 16; index++) {
    await sql`INSERT INTO bot_chat_bindings(owner_id,bot_id,chat_id,kind,created_at)
      VALUES (${OWNER},${`bot_${index.toString(16).padStart(16, "0")}`},'chat_many_bindings','group',${NOW})`.execute(db);
  }
  await sql`INSERT INTO bot_chat_bindings(owner_id,bot_id,chat_id,kind,project_id,created_at)
    VALUES (${OWNER},${BOT},'chat_many_bindings','thread','proj_saved','2026-09-27T12:00:01Z')`.execute(db);
  expect(await createBotBindingsRepository(db).forChat({ ownerId: OWNER, chatId: "chat_many_bindings" })).toHaveLength(16);
  await expect(createCustomBotChats({ chats: repository, agents }).directBot(owner, "chat_many_bindings"))
    .rejects.toEqual(new BotEntryError("unavailable"));
  await expect(createCustomBotChats({ chats: repository, agents }).directBot({ type: "personal", ownerId: "other_owner" }, "chat_many_bindings")).resolves.toBeNull();
});

it.each([[9, "wrong_thread_feature", "invalid_migrations"], [10, "unknown_future", "newer_schema"]] as const)("rejects v%i/%s before pending DDL", async (version, name, code) => {
  await bootstrapBotDatabase(db, [BOT_MIGRATIONS[0]!]);
  await sql`INSERT INTO bot_schema_migrations(version,name) VALUES (${version},${name})`.execute(db);
  const before = await rows("bot_schema_migrations");
  await expect(bootstrapBotDatabase(db)).rejects.toEqual(new BotSchemaError(code));
  expect(await rows("bot_schema_migrations")).toEqual(before);
  expect((await sql`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='managed_pi_sessions'`.execute(db)).rows).toEqual([]);
});
