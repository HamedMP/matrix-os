import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { CreateChatAgentRequestSchema, UpdateChatAgentRequestSchema } from "@matrix-os/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import {
  BotInstantiationError,
  createBotInstantiation,
  ensureBotWorkspace,
  instantiationPayloadHash,
} from "../../../packages/gateway/src/bots/instantiation.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotOperationReconciler } from "../../../packages/gateway/src/bots/reconciliation.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotOperationsRepository } from "../../../packages/gateway/src/bots/repositories/operations.js";
import { MATRIX_BOT_SELECTION } from "../../../packages/gateway/src/bots/selection.js";
import { managedCustomOperationRequestId } from "../../../packages/gateway/src/bots/custom-creation-authority.js";
import { OWNER, createBotStateDatabase, createRealBotStateDatabase } from "./bot-state-support.js";

const WRITING = { recipeId: "writing-bot", version: "2026-09-27.1" };
const request = (overrides: Record<string, unknown> = {}) => ({ clientRequestId: "req_instantiate_1", recipe: WRITING, ...overrides });
const scope = { type: "personal" as const, ownerId: OWNER };

let db: Kysely<OwnerBotDatabase>;
let destroy: () => Promise<void>;
let home: string;
let chats: ChatRepository;
let agents: ChatAgentStore;
let clock: number;

beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase());
  home = await mkdtemp(join(tmpdir(), "matrix-bot-instantiation-"));
  chats = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  agents = new ChatAgentStore({ homePath: home, db: db as unknown as Kysely<ChatDatabase> });
  await agents.bootstrap();
  clock = Date.parse("2026-09-28T10:00:00.000Z");
});
afterEach(async () => {
  await agents.close();
  await destroy();
  await rm(home, { recursive: true, force: true });
});

function setup(overrides: {
  agents?: Partial<Pick<ChatAgentStore, "createRecipeBot" | "get" | "count">>;
  chats?: Pick<ChatRepository, "withTransaction">;
  ensureWorkspace?: (botId: string) => Promise<void>;
  validateSelection?: Parameters<typeof createBotInstantiation>[0]["validateSelection"];
  recipes?: ReturnType<typeof createBotRecipeCatalog>;
} = {}) {
  return createBotInstantiation({
    db,
    validateSelection: overrides.validateSelection,
    chats: overrides.chats ?? chats,
    agents: {
      createRecipeBot: (owner, input) => agents.createRecipeBot(owner, input),
      get: (owner, id) => agents.get(owner, id),
      count: (owner) => agents.count(owner),
      ...overrides.agents,
    },
    recipes: overrides.recipes ?? createBotRecipeCatalog(),
    ensureWorkspace: overrides.ensureWorkspace ?? ((botId) => ensureBotWorkspace(home, botId)),
    now: () => new Date(clock),
  });
}

async function operation() {
  return createBotOperationsRepository(db).get(OWNER, "req_instantiate_1");
}

/** Fails the wrapped step once, then behaves normally. */
function failOnce<Args extends unknown[], Result>(step: (...args: Args) => Promise<Result>) {
  let failed = false;
  return vi.fn(async (...args: Args) => {
    if (!failed) {
      failed = true;
      throw new Error("process crashed at /home/matrix/secret");
    }
    return step(...args);
  });
}

describe("bot instantiation", () => {
  it("creates the bot, its workspace, and its direct chat once per request", async () => {
    const instantiation = setup();
    const created = await instantiation.instantiate(OWNER, request({ name: "Essay Partner" }));
    expect(created).toMatchObject({ operation: "created", agent: { name: "Essay Partner", revision: 1, status: "active" } });
    const replayed = await instantiation.instantiate(OWNER, request({ name: "Essay Partner" }));
    expect(replayed).toEqual({ ...created, operation: "replayed" });

    const agent = await agents.get(scope, created.agent.id);
    expect(agent).toMatchObject({ recipeRef: WRITING, selection: MATRIX_BOT_SELECTION, description: expect.any(String) });
    expect(agent!.instructions).toContain("draft and revise writing");
    const chat = await chats.get(scope, created.chatId);
    expect(chat?.chat).toMatchObject({ id: created.chatId, title: "Essay Partner" });
    await expect(createBotBindingsRepository(db).directChatId({ ownerId: OWNER, botId: created.agent.id })).resolves.toBe(created.chatId);
    expect((await stat(join(home, "bots", created.agent.id))).isDirectory()).toBe(true);
    await expect(operation()).resolves.toMatchObject({ status: "active", botId: created.agent.id, chatId: created.chatId });
    // Activation announces the bot once, with IDs only.
    const events = await db.selectFrom("chat_outbox").select(["event_type", "payload"]).where("chat_id", "=", created.chatId).execute();
    expect(events.filter((event) => event.event_type === "bot.created")).toEqual([
      { event_type: "bot.created", payload: { agentId: created.agent.id, chatId: created.chatId, revision: 1 } },
    ]);
  });

  it("refuses another payload for the same request, unknown recipes, and malformed input", async () => {
    const instantiation = setup();
    await instantiation.instantiate(OWNER, request());
    await expect(instantiation.instantiate(OWNER, request({ name: "Other" }))).rejects.toEqual(new BotInstantiationError("conflict"));
    await expect(instantiation.instantiate(OWNER, request({ clientRequestId: "req_2", recipe: { recipeId: "writing-bot", version: "1999-01-01.1" } })))
      .rejects.toEqual(new BotInstantiationError("invalid_request"));
    await expect(instantiation.instantiate(OWNER, { ...request({ clientRequestId: "req_3" }), botId: "bot_chosenbyclient" }))
      .rejects.toEqual(new BotInstantiationError("invalid_request"));
  });

  it("refuses an owner at the bot limit without reserving anything", async () => {
    const instantiation = setup({ agents: { count: async () => 100 } });
    await expect(instantiation.instantiate(OWNER, request())).rejects.toEqual(new BotInstantiationError("rate_limited"));
    await expect(operation()).resolves.toBeUndefined();
  });

  it("finishes a creation interrupted at each step with the same IDs, and never deletes an edited bot", async () => {
    const createRecipeBot = failOnce((owner: typeof scope, input: Parameters<ChatAgentStore["createRecipeBot"]>[1]) => agents.createRecipeBot(owner, input));
    const ensureWorkspace = failOnce((botId: string) => ensureBotWorkspace(home, botId));
    const withTransaction = failOnce(<T>(work: (repository: ChatRepository) => Promise<T>) => chats.withTransaction(work));
    const instantiation = setup({ agents: { createRecipeBot }, ensureWorkspace, chats: { withTransaction } as never });

    // 1. Definition file.
    await expect(instantiation.instantiate(OWNER, request())).rejects.toEqual(new BotInstantiationError("unavailable"));
    const reserved = await operation();
    expect(reserved).toMatchObject({ status: "failed_recoverable", failureCode: "definition_failed", attempts: 1 });
    // 2. Workspace, after the file exists.
    await expect(instantiation.instantiate(OWNER, request())).rejects.toEqual(new BotInstantiationError("unavailable"));
    expect(await operation()).toMatchObject({ status: "failed_recoverable", failureCode: "workspace_failed", botId: reserved!.botId });
    // The owner edits the saved bot while its creation is unfinished.
    await agents.update(scope, reserved!.botId, { baseRevision: 1, name: "Renamed" });
    // 3. Activation: the chat, binding, and activation roll back together.
    await expect(instantiation.instantiate(OWNER, request())).rejects.toEqual(new BotInstantiationError("unavailable"));
    expect(await operation()).toMatchObject({ status: "failed_recoverable", failureCode: "activation_failed" });
    await expect(chats.get(scope, reserved!.chatId)).resolves.toBeNull();

    const finished = await instantiation.instantiate(OWNER, request());
    expect(finished).toMatchObject({ operation: "replayed", chatId: reserved!.chatId, agent: { id: reserved!.botId, name: "Renamed", revision: 2 } });
    // One bot, kept with the owner's edit; retries never wrote a second definition.
    expect(await agents.count(scope)).toBe(1);
    expect(createRecipeBot).toHaveBeenCalledTimes(4);
  });

  it("recreates a workspace that disappeared before activation", async () => {
    const operations = createBotOperationsRepository(db);
    const { operation } = await operations.reserve({
      ownerId: OWNER, clientRequestId: "req_instantiate_1", payloadHash: instantiationPayloadHash(request()), now: new Date(clock).toISOString(),
    });
    // A process that stopped right after recording `file_created`, whose workspace was then removed.
    await agents.createRecipeBot(scope, {
      id: operation.botId, createHash: instantiationPayloadHash(request()),
      fields: { name: "Writing Bot", description: "", instructions: "Revise.", selection: MATRIX_BOT_SELECTION }, recipeRef: WRITING,
    });
    await ensureBotWorkspace(home, operation.botId);
    await operations.markFileCreated({ ownerId: OWNER, clientRequestId: "req_instantiate_1", baseRevision: operation.revision, now: new Date(clock).toISOString() });
    await rm(join(home, "bots", operation.botId), { recursive: true });

    const finished = await setup().instantiate(OWNER, request());
    expect(finished).toMatchObject({ operation: "replayed", agent: { id: operation.botId } });
    expect((await stat(join(home, "bots", operation.botId))).isDirectory()).toBe(true);
  });

  it("answers a duplicate that loses the race with the bot the other request finished", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const instantiation = setup({
      ensureWorkspace: async (botId) => {
        // The first request stops before recording `file_created`; the duplicate finishes meanwhile.
        if (calls++ === 0) await gate;
        await ensureBotWorkspace(home, botId);
      },
    });
    const first = instantiation.instantiate(OWNER, request());
    await vi.waitFor(() => expect(calls).toBe(1));
    const second = await instantiation.instantiate(OWNER, request());
    expect(second.operation).toBe("replayed");
    release();
    const finished = await first;
    expect(finished).toEqual({ ...second, operation: "created" });
    expect(await agents.count(scope)).toBe(1);
    await expect(operation()).resolves.toMatchObject({ status: "active", attempts: 0 });
  });

  it.runIf(process.env.MATRIX_TEST_POSTGRES_URL)("answers truly concurrent duplicates with one bot (real Postgres)", async () => {
    const real = await createRealBotStateDatabase();
    const realChats = new ChatRepository(real.db as unknown as Kysely<ChatDatabase>);
    const realAgents = new ChatAgentStore({ homePath: home, db: real.db as unknown as Kysely<ChatDatabase> });
    await realAgents.bootstrap();
    try {
      const instantiation = createBotInstantiation({
        db: real.db, chats: realChats, agents: realAgents, recipes: createBotRecipeCatalog(),
        ensureWorkspace: (botId) => ensureBotWorkspace(home, botId),
      });
      const results = await Promise.all([1, 2, 3].map(() => instantiation.instantiate(OWNER, request())));
      expect(new Set(results.map((result) => result.agent.id)).size).toBe(1);
      expect(new Set(results.map((result) => result.chatId)).size).toBe(1);
      expect(results.filter((result) => result.operation === "created")).toHaveLength(1);
      expect(await realAgents.count(scope)).toBe(1);
    } finally {
      await realAgents.close();
      await real.destroy();
    }
  });

  it("replays a created bot after its recipe version is retired", async () => {
    const created = await setup().instantiate(OWNER, request());
    const retired = createBotRecipeCatalog([]);
    await expect(setup({ recipes: retired }).instantiate(OWNER, request())).resolves.toEqual({ ...created, operation: "replayed" });
    await expect(setup({ recipes: retired }).instantiate(OWNER, request({ clientRequestId: "req_new" })))
      .rejects.toEqual(new BotInstantiationError("invalid_request"));
  });

  it("reuses only an empty workspace directory for a retried creation", async () => {
    await ensureBotWorkspace(home, "bot_aaaaaaaaaaaaaaaaaaaaaaaa");
    await expect(ensureBotWorkspace(home, "bot_aaaaaaaaaaaaaaaaaaaaaaaa")).resolves.toBeUndefined();
    await writeFile(join(home, "bots", "bot_aaaaaaaaaaaaaaaaaaaaaaaa", "notes.md"), "used");
    await expect(ensureBotWorkspace(home, "bot_aaaaaaaaaaaaaaaaaaaaaaaa")).rejects.toEqual(new BotInstantiationError("unavailable"));
    await mkdir(join(home, "elsewhere"));
    await symlink(join(home, "elsewhere"), join(home, "bots", "bot_bbbbbbbbbbbbbbbbbbbbbbbb"));
    await expect(ensureBotWorkspace(home, "bot_bbbbbbbbbbbbbbbbbbbbbbbb")).rejects.toThrow();
  });

  it("keeps recipeRef server-owned: clients cannot write it on create or update", () => {
    const fields = { name: "Mine", instructions: "Help", selection: MATRIX_BOT_SELECTION };
    expect(CreateChatAgentRequestSchema.safeParse({ ...fields, clientRequestId: "req_client_1", recipeRef: WRITING }).success).toBe(false);
    expect(UpdateChatAgentRequestSchema.safeParse({ baseRevision: 1, recipeRef: WRITING }).success).toBe(false);
  });

  it("hashes the normalized payload, not the request ID", () => {
    expect(instantiationPayloadHash({ recipe: WRITING })).toBe(instantiationPayloadHash({ recipe: { version: WRITING.version, recipeId: WRITING.recipeId } }));
    expect(instantiationPayloadHash({ recipe: WRITING })).not.toBe(instantiationPayloadHash({ recipe: WRITING, name: "A" }));
  });
});

describe("bot creation reconciliation", () => {
  it("finishes stale creations that have a definition and parks those that do not", async () => {
    const ensureWorkspace = failOnce((botId: string) => ensureBotWorkspace(home, botId));
    const instantiation = setup({ ensureWorkspace });
    await expect(instantiation.instantiate(OWNER, request())).rejects.toEqual(new BotInstantiationError("unavailable"));
    // A creation that crashed before writing its file: nothing to finish it from.
    await createBotOperationsRepository(db).reserve({
      ownerId: OWNER, clientRequestId: "req_orphan", payloadHash: "a".repeat(64), now: new Date(clock).toISOString(),
    });
    clock += 5 * 60_000;
    const reconciler = createBotOperationReconciler({
      operations: createBotOperationsRepository(db), instantiation, now: () => new Date(clock), intervalMs: 60_000,
    });
    await reconciler.start();
    await reconciler.stop();

    const finished = await operation();
    expect(finished).toMatchObject({ status: "active" });
    await expect(chats.get(scope, finished!.chatId)).resolves.not.toBeNull();
    await expect(createBotOperationsRepository(db).get(OWNER, "req_orphan"))
      .resolves.toMatchObject({ status: "failed_recoverable", failureCode: "definition_missing", attempts: 1 });
  });

  it("stops retrying a creation after five failed attempts", async () => {
    const resume = vi.fn(async () => { throw new Error("still failing"); });
    const operations = createBotOperationsRepository(db);
    const { operation: reserved } = await operations.reserve({ ownerId: OWNER, clientRequestId: "req_x", payloadHash: "b".repeat(64), now: new Date(clock).toISOString() });
    let current = reserved;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      current = await operations.markFailed({ ownerId: OWNER, clientRequestId: "req_x", baseRevision: current.revision, failureCode: "activation_failed", now: new Date(clock).toISOString() });
    }
    clock += 5 * 60_000;
    const reconciler = createBotOperationReconciler({ operations, instantiation: { resume }, now: () => new Date(clock) });
    await reconciler.runOnce();
    expect(resume).not.toHaveBeenCalled();
  });
});

it("persists an authorized managed model in the bot definition and includes it in idempotency", async () => {
  const selection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
  const validateSelection = vi.fn(async () => undefined);
  const instantiation = setup({ validateSelection });
  const created = await instantiation.instantiate(OWNER, request({ selection }));
  expect(validateSelection).toHaveBeenCalledWith(OWNER, selection);
  expect(await agents.get(scope, created.agent.id)).toMatchObject({ selection });
  expect((await chats.get(scope, created.chatId))?.chat.currentSelection).toEqual(selection);
  await expect(instantiation.instantiate(OWNER, request({ selection: { ...selection, model: "other-model" } }))).rejects.toEqual(new BotInstantiationError("conflict"));
});
it("fails a managed create before reserving IDs when route admission is unavailable", async () => {
  await expect(setup().instantiate(OWNER, request({ selection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" } }))).rejects.toEqual(new BotInstantiationError("invalid_request"));
  expect(await operation()).toBeUndefined();
});

it("creates a custom subscription Bot through a recoverable server-owned operation and binding", async () => {
 const selection={instanceId:"matrix_chatgpt_plan",model:"gpt-test",options:[{id:"accountId",value:"account-owner"},{id:"grantRevision",value:"3"}]};
 const validate=vi.fn(async()=>undefined);
 const service=setup({validateSelection:validate});
 const input={clientRequestId:"req_custom_1",name:"Custom helper",description:"Owned instructions",instructions:"Reply with the requested marker",selection};
 const first=await service.createCustom(OWNER,input);
 const replay=await service.createCustom(OWNER,input);
 expect(replay.chatId).toBe(first.chatId);
 expect(replay.agent.id).toBe(first.agent.id);
 const agent=await agents.get(scope,first.agent.id);
 expect(agent).toMatchObject({name:input.name,instructions:input.instructions,selection,recipeRef:{recipeId:"custom-coordinator",version:"1"}});
 expect(await createBotBindingsRepository(db).directChatId({ownerId:OWNER,botId:first.agent.id})).toBe(first.chatId);
 expect((await db.selectFrom("bot_operations").selectAll().where("bot_id","=",first.agent.id).executeTakeFirst())?.status).toBe("active");
 await expect(service.createCustom(OWNER,{...input,instructions:"changed"})).rejects.toMatchObject({code:"conflict"});
 expect(validate).toHaveBeenCalledWith(OWNER,selection);
});
it("refuses forged custom coordinator references and ordinary subscription IDs before writes",async()=>{
 const service=setup({validateSelection:vi.fn(async()=>undefined)});
 await expect(service.instantiate(OWNER,request({recipe:{recipeId:"custom-coordinator",version:"1"}}))).rejects.toMatchObject({code:"invalid_request"});
 for(const instanceId of ["matrix_pi_chatgpt_plan","codex_default"]){
 await expect(service.createCustom(OWNER,{clientRequestId:"req_custom_bad",name:"Bad",description:"",instructions:"No effects",selection:{instanceId,model:"gpt"}})).rejects.toMatchObject({code:"invalid_request"});
 }
 expect(await db.selectFrom("bot_operations").selectAll().execute()).toHaveLength(0);
});

it("uses the startup validator for Automatic and retains downstream model refusal", async () => {
 const {createBotCreationSelectionValidator}=await import("../../../packages/gateway/src/bots/creation-selection.js");
 const validate=createBotCreationSelectionValidator({available:()=>true,providers:{getSnapshot:vi.fn(async()=>{throw new Error("unavailable");})}});
 const result=await setup({validateSelection:validate}).instantiate(OWNER,request({selection:MATRIX_BOT_SELECTION}));
 expect((await agents.get(scope,result.agent.id))?.selection).toEqual(MATRIX_BOT_SELECTION);
});
it("requires active owner-scoped provenance and exact definition/account/model for every custom continuation",async()=>{
 const {createBotProcedureResolver}=await import("../../../packages/gateway/src/bots/custom-procedure.js");
 const {CreateManagedCustomBotRequestSchema}=await import("@matrix-os/contracts");
 const selection={instanceId:"matrix_chatgpt_plan",model:"gpt-test",options:[{id:"accountId",value:"account-owner"},{id:"grantRevision",value:"3"}]};
 const service=setup({validateSelection:vi.fn(async()=>undefined)});
 const input={clientRequestId:"req_custom_provenance",name:"Custom",instructions:"Never send email",selection};
 const result=await service.createCustom(OWNER,input); const agent=(await agents.get(scope,result.agent.id))!;
 const resolver=createBotProcedureResolver({db,agents,recipes:createBotRecipeCatalog(),customRecipes:{catalog:vi.fn(),resolve:vi.fn(),revalidate:vi.fn()}});
 await expect(resolver.assert(OWNER,agent,result.chatId,agent.revision)).resolves.toBeUndefined();
 await expect(resolver.assert("other-owner",agent,result.chatId)).rejects.toMatchObject({code:"model_unavailable"});
 await expect(resolver.assert(OWNER,agent,"chat_foreign")).rejects.toMatchObject({code:"model_unavailable"});
 const binding={ownerId:OWNER,botId:agent.id,chatId:result.chatId,managedDefinitionRevision:agent.revision,accessSourceId:"matrix_chatgpt_plan",route:{modelId:"gpt-test"},subscription:{accountId:"account-owner",grantRevision:3}} as unknown as import("../../../packages/gateway/src/bots/runtime-registry.js").BotRuntimeBinding;
 await expect(resolver.revalidate(binding)).resolves.toBeUndefined();
 await expect(resolver.revalidate({...binding,route:{...binding.route,modelId:"foreign-model"}})).rejects.toMatchObject({code:"model_unavailable"});
 await expect(resolver.assert(OWNER,{...agent,archived:true},result.chatId)).rejects.toMatchObject({code:"model_unavailable"});
 await db.updateTable("bot_chat_bindings").set({removed_at:new Date(clock).toISOString()}).where("bot_id","=",agent.id).execute();
 await expect(resolver.assert(OWNER,agent,result.chatId)).rejects.toMatchObject({code:"model_unavailable"});
 await db.updateTable("bot_chat_bindings").set({removed_at:null}).where("bot_id","=",agent.id).execute();
 await db.updateTable("bot_operations").set({payload_hash:"f".repeat(64)}).where("bot_id","=",agent.id).execute();
 await expect(resolver.assert(OWNER,agent,result.chatId)).rejects.toMatchObject({code:"model_unavailable"});
 await db.updateTable("bot_operations").set({payload_hash:(await import("node:crypto")).createHash("sha256").update(JSON.stringify(["managed-custom-v1",CreateManagedCustomBotRequestSchema.parse(input)])).digest("hex")}).where("bot_id","=",agent.id).execute();
 await expect(resolver.assert(OWNER,agent,result.chatId)).resolves.toBeUndefined();
 await expect(resolver.revalidate({...binding,subscription:{accountId:"foreign",grantRevision:3}} as never)).rejects.toMatchObject({code:"model_unavailable"});
 await agents.update(scope,agent.id,{baseRevision:agent.revision,name:"Renamed"});
 await expect(resolver.revalidate(binding)).rejects.toMatchObject({code:"model_unavailable"});
 const updated=(await agents.get(scope,agent.id))!;
 await db.deleteFrom("bot_operations").where("owner_id","=",OWNER).where("bot_id","=",agent.id).execute();
 await expect(resolver.assert(OWNER,updated,result.chatId)).rejects.toMatchObject({code:"model_unavailable"});
 expect(CreateManagedCustomBotRequestSchema.safeParse({...input,recipeRef:{recipeId:"custom-coordinator",version:"1"}}).success).toBe(false);
});
it("refuses revoked subscription creation before reserving a definition or Chat",async()=>{
 const service=setup({validateSelection:async()=>{throw new BotInstantiationError("invalid_request");}});
 await expect(service.createCustom(OWNER,{clientRequestId:"req_revoked",name:"Revoked",instructions:"No effects",selection:{instanceId:"matrix_chatgpt_plan",model:"gpt",options:[{id:"accountId",value:"account-revoked"},{id:"grantRevision",value:"1"}]}})).rejects.toMatchObject({code:"invalid_request"});
 expect(await db.selectFrom("bot_operations").selectAll().execute()).toHaveLength(0);
 expect(await agents.list(scope)).toHaveLength(0);
});

it("does not turn an unrelated stored definition into a coordinator from a forged reference and active operation", async()=>{
 const {createBotProcedureResolver}=await import("../../../packages/gateway/src/bots/custom-procedure.js");
 const operation=(await createBotOperationsRepository(db).reserve({ownerId:OWNER,clientRequestId:"req_forged_custom",payloadHash:"a".repeat(64),now:new Date(clock).toISOString()})).operation;
 await agents.createRecipeBot(scope,{id:operation.botId,createHash:"b".repeat(64),recipeRef:{recipeId:"custom-coordinator",version:"1"},fields:{name:"Forged",description:"",instructions:"No borrowed authority",selection:{instanceId:"matrix_chatgpt_plan",model:"gpt",options:[{id:"accountId",value:"own-account"},{id:"grantRevision",value:"3"}]}}});
 const fileCreated=await createBotOperationsRepository(db).markFileCreated({ownerId:OWNER,clientRequestId:operation.clientRequestId,baseRevision:operation.revision,now:new Date(clock).toISOString()});
 await chats.create(scope,{id:operation.chatId,clientRequestId:"req_forged_chat",title:"Forged"});
 await createBotBindingsRepository(db).bindDirect({ownerId:OWNER,botId:operation.botId,chatId:operation.chatId,now:new Date(clock).toISOString()});
 await createBotOperationsRepository(db).markActive({ownerId:OWNER,clientRequestId:operation.clientRequestId,baseRevision:fileCreated.revision,now:new Date(clock).toISOString()});
 const resolver=createBotProcedureResolver({db,agents,recipes:createBotRecipeCatalog(),customRecipes:{catalog:vi.fn(),resolve:vi.fn(),revalidate:vi.fn()}});
 await expect(resolver.assert(OWNER,(await agents.get(scope,operation.botId))!,operation.chatId)).rejects.toMatchObject({code:"model_unavailable"});
});

it("does not adopt an ordinary recipe operation with a forged custom reference and its valid original hash", async () => {
  const { createBotProcedureResolver } = await import("../../../packages/gateway/src/bots/custom-procedure.js");
  const result = await setup().instantiate(OWNER, request());
  const ordinary = (await agents.get(scope, result.agent.id))!;
  const resolver = createBotProcedureResolver({ db, agents, recipes: createBotRecipeCatalog(), customRecipes: {
    catalog: vi.fn(), resolve: vi.fn(), revalidate: vi.fn(),
  } });
  await expect(resolver.assert(OWNER, { ...ordinary, recipeRef: { recipeId: "custom-coordinator", version: "1" } }, result.chatId))
    .rejects.toMatchObject({ code: "model_unavailable" });
});

it("rejects the reserved custom-operation namespace through ordinary create before reservation or replay", async () => {
  const reserved = managedCustomOperationRequestId(OWNER, "req_public_custom");
  const service = setup();
  await expect(service.instantiate(OWNER, request({ clientRequestId: reserved }))).rejects.toMatchObject({ code: "invalid_request" });
  expect(await db.selectFrom("bot_operations").selectAll().execute()).toHaveLength(0);
  // A historical or forged operation must not get a replay shortcut through the generic endpoint.
  const operations = createBotOperationsRepository(db);
  const { operation } = await operations.reserve({ ownerId: OWNER, clientRequestId: reserved,
    payloadHash: instantiationPayloadHash(request()), now: new Date(clock).toISOString() });
  await agents.createRecipeBot(scope, { id: operation.botId, createHash: operation.payloadHash, recipeRef: WRITING,
    fields: { name: "Historical ordinary Bot", description: "", instructions: "No borrowed authority", selection: MATRIX_BOT_SELECTION } });
  const fileCreated = await operations.markFileCreated({ ownerId: OWNER, clientRequestId: reserved, baseRevision: operation.revision, now: new Date(clock).toISOString() });
  await chats.create(scope, { id: operation.chatId, clientRequestId: "req_historical_chat", title: "Historical" });
  await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: operation.botId, chatId: operation.chatId, now: new Date(clock).toISOString() });
  await operations.markActive({ ownerId: OWNER, clientRequestId: reserved, baseRevision: fileCreated.revision, now: new Date(clock).toISOString() });
  await expect(service.instantiate(OWNER, request({ clientRequestId: reserved }))).rejects.toMatchObject({ code: "invalid_request" });
  expect(await agents.count(scope)).toBe(1);
  expect(managedCustomOperationRequestId("other-owner", "req_public_custom")).not.toBe(reserved);
});

it.runIf(process.env.MATRIX_TEST_POSTGRES_URL)("serializes custom creates across stores and rolls activation back on pooled PostgreSQL", async () => {
  const real = await createRealBotStateDatabase();
  const realChats = new ChatRepository(real.db as unknown as Kysely<ChatDatabase>);
  const stores = [1, 2].map(() => new ChatAgentStore({ homePath: home, db: real.db as unknown as Kysely<ChatDatabase> }));
  const selection = { instanceId: "matrix_chatgpt_plan", model: "gpt-owner", options: [
    { id: "accountId", value: "owner-account" }, { id: "grantRevision", value: "3" },
  ] };
  const input = { clientRequestId: "req_custom_pooled", name: "Pooled Bot", instructions: "Use confirmed actions only", selection };
  const service = (store: ChatAgentStore, repository: Pick<ChatRepository, "withTransaction"> = realChats) => createBotInstantiation({
    db: real.db, chats: repository, agents: store, recipes: createBotRecipeCatalog(),
    validateSelection: async (_owner, selected) => { expect(selected).toEqual(selection); },
    ensureWorkspace: botId => ensureBotWorkspace(home, botId),
  });
  try {
    // Bootstrap the shared schema before racing creation from independent stores.
    for (const store of stores) await store.bootstrap();
    const services = stores.map(store => service(store));
    const results = await Promise.all([services[0]!, services[1]!, services[0]!].map(instance => instance.createCustom(OWNER, input)));
    expect(new Set(results.map(result => result.agent.id)).size).toBe(1);
    expect(new Set(results.map(result => result.chatId)).size).toBe(1);
    expect(results.filter(result => result.operation === "created")).toHaveLength(1);
    expect(await stores[0]!.count(scope)).toBe(1);
    expect(await real.db.selectFrom("chat_outbox").selectAll().where("event_type", "=", "bot.created").execute()).toHaveLength(1);
    await expect(services[1]!.createCustom(OWNER, { ...input, instructions: "Changed payload" })).rejects.toMatchObject({ code: "conflict" });

    // Fail after the Chat, binding, activation and outbox have all been written inside the transaction.
    const broken = service(stores[0]!, { withTransaction: <T>(work: (repository: ChatRepository) => Promise<T>) =>
      realChats.withTransaction(async repository => { await work(repository); throw new Error("Injected pre-commit failure"); }) });
    const retryInput = { ...input, clientRequestId: "req_custom_pooled_rollback" };
    await expect(broken.createCustom(OWNER, retryInput)).rejects.toMatchObject({ code: "unavailable" });
    const operation = (await createBotOperationsRepository(real.db).get(OWNER, managedCustomOperationRequestId(OWNER, retryInput.clientRequestId)))!;
    expect(operation).toMatchObject({ status: "failed_recoverable", failureCode: "activation_failed" });
    expect(await realChats.get(scope, operation.chatId)).toBeNull();
    expect(await createBotBindingsRepository(real.db).directChatId({ ownerId: OWNER, botId: operation.botId })).toBeUndefined();
    expect(await real.db.selectFrom("chat_outbox").selectAll().where("chat_id", "=", operation.chatId).execute()).toHaveLength(0);
    expect(await stores[1]!.get(scope, operation.botId)).toMatchObject({ selection });
    const recovered = await services[1]!.createCustom(OWNER, retryInput);
    expect(recovered).toMatchObject({ operation: "replayed", chatId: operation.chatId, agent: { id: operation.botId } });
    expect(await stores[0]!.count(scope)).toBe(2);
    const recoveredEvents = await real.db.selectFrom("chat_outbox").select("event_type")
      .where("chat_id", "=", operation.chatId).execute();
    expect(recoveredEvents.map(event => event.event_type).sort()).toEqual(["bot.created", "chat.created"]);
  } finally {
    await Promise.all(stores.map(store => store.close()));
    await real.destroy();
  }
});
