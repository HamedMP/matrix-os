import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatAgentListResponseSchema, CanonicalChatSnapshotSchema } from "@matrix-os/contracts";
import { createChatAgentRoutes } from "../../../packages/gateway/src/chat/agent-routes.js";
import { ChatAgentContext } from "../../../packages/gateway/src/chat/agent-context.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { createChatAgentRecipeResolver } from "../../../packages/gateway/src/chat/agent-recipe.js";
import { createBotCreationSelectionValidator } from "../../../packages/gateway/src/bots/creation-selection.js";
import { createCustomBotChats } from "../../../packages/gateway/src/bots/custom-direct-chat.js";
import { createBotProcedureResolver } from "../../../packages/gateway/src/bots/custom-procedure.js";
import { createManagedCustomRecovery } from "../../../packages/gateway/src/bots/managed-custom-recovery.js";
import { createBotInstantiation, ensureBotWorkspace } from "../../../packages/gateway/src/bots/instantiation.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotGrantsRepository } from "../../../packages/gateway/src/bots/repositories/grants.js";
import { createBotRoutes } from "../../../packages/gateway/src/bots/routes.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import { OWNER, NOW, createBotStateDatabase, createRealBotStateDatabase } from "./bot-state-support.js";
import { MissingRequestPrincipalError } from "../../../packages/gateway/src/request-principal.js";

const owner = { type: "personal" as const, ownerId: OWNER };
const selection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
let state: Awaited<ReturnType<typeof createBotStateDatabase>>;
let home: string, chatId: string, botId: string;
let agents: ChatAgentStore, chats: ChatRepository;
let recovery: ReturnType<typeof createManagedCustomRecovery>;
let snapshot: ReturnType<typeof makeAiProviderSnapshot>;
let runtimeActive: boolean;
let recipes: ReturnType<typeof createChatAgentRecipeResolver>;

beforeEach(async () => {
  state = process.env.MATRIX_TEST_POSTGRES_URL ? await createRealBotStateDatabase() : await createBotStateDatabase();
  home = await mkdtemp(join(tmpdir(), "matrix-bot-recovery-"));
  chats = new ChatRepository(state.db as unknown as Kysely<ChatDatabase>);
  agents = new ChatAgentStore({ homePath: home, db: chats.kysely }); await agents.bootstrap();
  snapshot = makeAiProviderSnapshot(); runtimeActive = false;
  recipes = createChatAgentRecipeResolver({ skillsRoot: home, services: [{ id: "github", name: "Github" }] });
  const bot = await agents.create(owner, { clientRequestId: "req_legacy_funded", name: "Github helper", description: "Existing helper",
    instructions: "Preserve confirmed work", selection, recipe: { skills: [], integrations: [{ service: "github", accountLabel: "Work" }], output: "A verified review" } });
  botId = bot.id;
  chatId = await createCustomBotChats({ chats, agents }).ensureDirectChat(owner, bot.id);
  await chats.admitTurn(owner, { chatId, baseRevision: 0,
    message: { id: "msg_legacy", chatId, seq: 1, role: "user", state: "committed", purpose: "ai_request", turnId: "cturn_legacy", parts: [{ type: "text", text: "Review my project" }], createdAt: NOW },
    turn: { id: "cturn_legacy", chatId, clientRequestId: "req_legacy_turn", baseMessageSeq: 0, inputMessageId: "msg_legacy", status: "accepted", createdAt: NOW, updatedAt: NOW },
    run: { id: "run_legacy", chatId, turnId: "cturn_legacy", attempt: 1, driverKind: "matrix_pi", instanceId: "matrix_pi_default", selection,
      interactionMode: "default", permissionMode: "full_access", status: "accepted", historyBoundarySeq: 0,
      context: { version: 1, requestHash: "a".repeat(64), agent: { id: botId, revision: 1, name: bot.name, instructions: bot.instructions }, chats: [] },
      capabilitySnapshot: { revision: "legacy", rootChat: true, attachments: [], resources: [], tools: [], approvals: false, userInput: false,
        resume: false, cancellation: true, worktrees: "none", interactionModes: ["default"], permissionModes: ["full_access"] }, createdAt: NOW, updatedAt: NOW },
  });
  await chats.finishRun(owner, { chatId, runId: "run_legacy", outcome: "failed", completedAt: NOW });
  await createBotGrantsRepository(state.db).grant({ ownerId: OWNER, botId, service: "github", connectionId: "conn_original", accountLabel: "Work",
    effects: ["read"], audience: "direct", grantedByActorId: OWNER, now: NOW });
  await state.db.insertInto("bot_tasks").values({ task_id: "task_originalhistory", owner_id: OWNER, bot_id: botId, chat_id: chatId,
    parent_task_id: null, coordinator_bot_id: null, status: "failed", run_id: null, budget: JSON.stringify({ handoffs: 0, depth: 0, toolActions: 0, microUsd: 0 }),
    active_ms: 0, running_since: null, blocked_reason: null, created_at: NOW, updated_at: NOW }).execute();
  await state.db.insertInto("bot_interactions").values({ interaction_id: "in_originalhistory", owner_id: OWNER, bot_id: botId, chat_id: chatId,
    task_id: "task_originalhistory", kind: "approval", payload: JSON.stringify({ kind: "approval", tool: "github.send", argsDigest: "b".repeat(64),
      account: { service: "github", label: "Work" }, audience: "direct", preview: "A past action", policyRevision: 1 }),
    responder_actor_id: OWNER, blocking: true, status: "resolved", resolution: JSON.stringify({ action: "deny" }), expires_at: "2026-09-27T13:00:00.000Z",
    created_at: NOW, resolved_at: NOW }).execute();
  await state.db.insertInto("bot_approvals").values({ approval_id: "in_originalhistory", owner_id: OWNER, bot_id: botId, task_id: "task_originalhistory",
    run_id: "run_legacy", tool: "github.send", args_hash: "b".repeat(64), account: "conn_original", audience: "direct", policy_revision: 1,
    status: "denied", claimed_at: null, expires_at: NOW, revision: 1, created_at: NOW, updated_at: NOW }).execute();
  recovery = setup();
});
afterEach(async () => { await agents.close(); await state.destroy(); await rm(home, { recursive: true, force: true }); });

function setup(overrides: Partial<Parameters<typeof createManagedCustomRecovery>[0]> = {}) {
  return createManagedCustomRecovery({ chats, agents, customRecipes: recipes,
    validateSelection: createBotCreationSelectionValidator({ available: () => true, providers: { getSnapshot: async () => snapshot } }),
    ensureWorkspace: id => ensureBotWorkspace(home, id), hasLiveRuntime: () => runtimeActive, ...overrides });
}

it("validates the source once outside owner and Chat transactions and replays without discovery", async () => {
  let transactions = 0;
  const validateSelection = vi.fn(async () => { expect(transactions).toBe(0); });
  const service = setup({ validateSelection, chats: { withTransaction: work => chats.withTransaction(async repository => {
    transactions++;
    try { return await work(repository); } finally { transactions--; }
  }) } });
  await expect(service.recover(OWNER, botId, { baseRevision: 1 })).resolves.toMatchObject({ chatId });
  expect(validateSelection).toHaveBeenCalledTimes(1);
  validateSelection.mockRejectedValue(new Error("Discovery is unavailable"));
  await expect(service.recover(OWNER, botId, { baseRevision: 1 })).resolves.toMatchObject({ chatId });
  expect(validateSelection).toHaveBeenCalledTimes(1);
});

it("rejects a definition changed during source validation before reserving recovery", async () => {
  let transactions = 0;
  const service = setup({ chats: { withTransaction: work => chats.withTransaction(async repository => {
    transactions++;
    try { return await work(repository); } finally { transactions--; }
  }) }, validateSelection: async () => {
    expect(transactions).toBe(0);
    await agents.update(owner, botId, { baseRevision: 1, instructions: "An owner's concurrent edit" });
  } });
  await expect(service.recover(OWNER, botId, { baseRevision: 1 })).rejects.toMatchObject({ code: "conflict" });
  expect((await agents.get(owner, botId))!.instructions).toBe("An owner's concurrent edit");
  expect(await state.db.selectFrom("bot_operations").selectAll().execute()).toHaveLength(0);
});
async function preservedRows() {
  return {
    messages: await state.db.selectFrom("chat_messages").selectAll().execute(), turns: await state.db.selectFrom("chat_turns").selectAll().execute(),
    runs: await state.db.selectFrom("chat_runs").selectAll().execute(), events: await state.db.selectFrom("chat_run_events").selectAll().execute(),
    grants: await state.db.selectFrom("bot_grants").selectAll().execute(), approvals: await state.db.selectFrom("bot_approvals").selectAll().execute(),
    tasks: await state.db.selectFrom("bot_tasks").selectAll().execute(),
    interactions: await state.db.selectFrom("bot_interactions").selectAll().execute(),
    binding: await state.db.selectFrom("bot_chat_bindings").selectAll().execute(),
  };
}

it("recovers the exact owned Bot and Chat while preserving history, source, original hash and grants", async () => {
  const before = await agents.getCreationSnapshot(owner, botId), rows = await preservedRows();
  const response = await createBotRoutes({ recovery, getPrincipal: () => ({ userId: OWNER, source: "jwt" }) })
    .request(`/api/chat-agents/${botId}/recover-managed-custom`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: 1 }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ agent: { id: botId, revision: 2 }, chatId });
  const after = await agents.getCreationSnapshot(owner, botId);
  expect(after).toEqual({ createHash: before!.createHash, agent: { ...before!.agent, revision: 2,
    updatedAt: after!.agent.updatedAt, recipeRef: { recipeId: "custom-coordinator", version: "1" } } });
  expect(await preservedRows()).toEqual(rows);
  expect(await state.db.selectFrom("chats").select(["bound_driver_kind", "bound_instance_id", "bound_at_turn_id"]).executeTakeFirst())
    .toEqual({ bound_driver_kind: null, bound_instance_id: null, bound_at_turn_id: null });
  expect((await chats.get(owner, chatId))!.chat.currentSelection).toEqual({ instanceId: "matrix_bot_default", model: selection.model });
  const exported = (await chats.exportChat(owner, chatId))!;
  expect(exported.chat.providerBinding).toBeUndefined();
  expect(exported.runs).toHaveLength(1);
  expect(exported.runs[0]).toMatchObject({ status: "failed", driverKind: "matrix_pi", context: { agent: { id: botId } } });
  expect(exported.messages[0]!.parts).toEqual([{ type: "text", text: "Review my project" }]);
  expect(CanonicalChatSnapshotSchema.safeParse({ chat: exported.chat.chat, messages: exported.messages, turns: exported.turns,
    runs: exported.runs, activities: exported.activities,
    inspector: { chatId, context: {}, files: [], terminals: [], changes: { availability: "unavailable", reason: "history_only" } },
  }).success).toBe(true);
  const procedure = createBotProcedureResolver({ db: state.db, agents, recipes: createBotRecipeCatalog(), customRecipes: recipes });
  await expect(procedure.assert(OWNER, after!.agent, chatId)).resolves.toBeUndefined();
  const replay = await recovery.recover(OWNER, botId, { baseRevision: 1 });
  expect(replay).toMatchObject({ agent: { id: botId, revision: 2 }, chatId, operation: "replayed" });
  expect(await state.db.selectFrom("bot_operations").selectAll().execute()).toHaveLength(1);
  expect(await agents.count(owner)).toBe(1);
});

it.each(["archived", "removed", "shared", "bound", "ordinary-history", "active", "active-turn", "runtime", "revision", "source", "options", "task", "effect", "approval"])("refuses %s recovery without changing data", async condition => {
  let revision = 1;
  if (condition === "archived") await agents.update(owner, botId, { baseRevision: 1, archived: true });
  if (condition === "removed") await state.db.updateTable("bot_chat_bindings").set({ removed_at: NOW }).execute();
  if (condition === "shared") await state.db.updateTable("chats").set({ collaboration: JSON.stringify({ sharedScopeId: "scope_other" }) }).execute();
  if (condition === "bound") await state.db.updateTable("chats").set({ bound_driver_kind: "matrix_pi", bound_instance_id: "matrix_pi_default", bound_at_turn_id: "cturn_legacy" }).execute();
  if (condition === "ordinary-history") await state.db.updateTable("chat_runs").set({ context_snapshot: null }).execute();
  if (condition === "active") await state.db.updateTable("chat_runs").set({ status: "running" }).execute();
  if (condition === "active-turn") await state.db.updateTable("chat_turns").set({ status: "running" }).execute();
  if (condition === "source" || condition === "options") {
    await agents.update(owner, botId, { baseRevision: 1, selection: condition === "source"
      ? { instanceId: "hermes_default", model: "hermes" } : { ...selection, options: [{ id: "thinking", value: "high" }] } });
    revision = 2;
  }
  if (condition === "runtime") runtimeActive = true;
  if (condition === "task") await state.db.updateTable("bot_tasks").set({ status: "running", running_since: NOW }).execute();
  if (condition === "approval") await state.db.updateTable("bot_approvals").set({ status: "approved", expires_at: "2099-01-01T00:00:00.000Z" }).execute();
  if (condition === "effect") await state.db.insertInto("bot_tool_checkpoints").values({ checkpoint_id: "ckpt_outstanding", owner_id: OWNER,
    task_id: "task_originalhistory", run_id: "run_legacy", tool_call_id: "past_call", action: JSON.stringify({ tool: "github.send" }),
    action_hash: "a".repeat(64), effect_class: "send", phase: "effect_unknown", outcome_ref: null, created_at: NOW, updated_at: NOW }).execute();
  if (condition === "revision") revision = 2;
  const before = await agents.get(owner, botId), rows = await preservedRows();
  await expect(recovery.recover(OWNER, botId, { baseRevision: revision })).rejects.toMatchObject({ code: expect.stringMatching(/conflict|not_found/) });
  expect(await agents.get(owner, botId)).toEqual(before); expect(await preservedRows()).toEqual(rows);
  expect(await state.db.selectFrom("bot_operations").selectAll().execute()).toHaveLength(0);
});

it("rejects foreign owners, unsupported sources, prompt overflow and client provenance before reservation", async () => {
  await expect(recovery.recover("foreign-owner", botId, { baseRevision: 1 })).rejects.toMatchObject({ code: "not_found" });
  await expect(recovery.recover(OWNER, botId, { baseRevision: 1, chatId })).rejects.toMatchObject({ code: "invalid_request" });
  snapshot.accessSources[0]!.state = "disabled";
  await expect(recovery.recover(OWNER, botId, { baseRevision: 1 })).rejects.toMatchObject({ code: "invalid_request" });
  snapshot = makeAiProviderSnapshot();
  await agents.update(owner, botId, { baseRevision: 1, instructions: "漢".repeat(7500) });
  await expect(recovery.recover(OWNER, botId, { baseRevision: 2 })).rejects.toMatchObject({ code: "invalid_request" });
  expect(await state.db.selectFrom("bot_operations").selectAll().execute()).toHaveLength(0);
});

it("keeps an interrupted reservation unpromoted during generic reconciliation and retries the same IDs", async () => {
  const failed = setup({ ensureWorkspace: async () => { throw new Error("Injected workspace failure"); } });
  await expect(failed.recover(OWNER, botId, { baseRevision: 1 })).rejects.toMatchObject({ code: "unavailable" });
  const operation = (await state.db.selectFrom("bot_operations").selectAll().executeTakeFirst())!;
  expect(operation).toMatchObject({ bot_id: botId, chat_id: chatId, status: "reserved" });
  const generic = createBotInstantiation({ db: state.db, chats, agents, recipes: createBotRecipeCatalog(), ensureWorkspace: vi.fn() });
  const { createBotOperationsRepository } = await import("../../../packages/gateway/src/bots/repositories/operations.js");
  await generic.resume((await createBotOperationsRepository(state.db).get(OWNER, operation.client_request_id))!);
  expect((await agents.get(owner, botId))!.recipeRef).toBeUndefined();
  expect((await state.db.selectFrom("bot_operations").selectAll().executeTakeFirst())!.status).toBe("reserved");
  expect(await recovery.recover(OWNER, botId, { baseRevision: 1 })).toMatchObject({ agent: { id: botId }, chatId });
});

it("retries after file promotion with rolled-back activation without replacing any owner records", async () => {
  let transaction = 0;
  const broken = setup({ chats: { withTransaction: work => chats.withTransaction(async repository => {
    const value = await work(repository); if (++transaction === 3) throw new Error("Injected activation rollback"); return value;
  }) } });
  const rows = await preservedRows();
  await expect(broken.recover(OWNER, botId, { baseRevision: 1 })).rejects.toMatchObject({ code: "unavailable" });
  const promoted = (await agents.get(owner, botId))!;
  expect(promoted).toMatchObject({ revision: 2, recipeRef: { recipeId: "custom-coordinator", version: "1" } });
  await expect(createBotProcedureResolver({ db: state.db, agents, recipes: createBotRecipeCatalog(), customRecipes: recipes }).assert(OWNER, promoted, chatId))
    .rejects.toMatchObject({ code: "model_unavailable" });
  expect(await preservedRows()).toEqual(rows);
  expect(await recovery.recover(OWNER, botId, { baseRevision: 1 })).toMatchObject({ agent: { id: botId, revision: 2 }, chatId });
  expect(await preservedRows()).toEqual(rows);
});

it("refuses accepted queued work without mutating identity", async () => {
  await state.db.updateTable("chat_runs").set({ status: "running", outcome: null, completed_at: null }).execute();
  await state.db.updateTable("chat_turns").set({ status: "running" }).execute();
  await chats.enqueueQueuedTurn(owner, { chatId, clientRequestId: "req_recovery_queue", baseRevision: (await chats.get(owner, chatId))!.chat.revision,
    queuedTurnId: "qturn_recovery", driverKind: "matrix_pi", createdAt: NOW,
    capabilitySnapshot: { revision: "queue", rootChat: true, attachments: [], resources: [], tools: [], approvals: false, userInput: false,
      resume: false, cancellation: true, worktrees: "none", interactionModes: ["default"], permissionModes: ["full_access"] },
    parts: [{ type: "text", text: "Pending work" }], selection, interactionMode: "default", permissionMode: "full_access" });
  await chats.finishRun(owner, { chatId, runId: "run_legacy", outcome: "failed", completedAt: NOW });
  await expect(recovery.recover(OWNER, botId, { baseRevision: 1 })).rejects.toMatchObject({ code: "conflict" });
  expect((await agents.get(owner, botId))!.revision).toBe(1);
  expect(await state.db.selectFrom("bot_operations").selectAll().execute()).toHaveLength(0);
});

it("requires authentication and validates bounded recovery DTOs before calling the service", async () => {
  const recover = vi.fn(async () => { throw new Error("private path /home/secret database error"); });
  const routes = createBotRoutes({ recovery: { recover }, getPrincipal: () => ({ userId: OWNER, source: "jwt" }) });
  const post = (body: unknown, path = botId) => routes.request(`/api/chat-agents/${path}/recover-managed-custom`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  for (const body of [{}, { baseRevision: 0 }, { baseRevision: 1, ownerId: "foreign" }]) expect((await post(body)).status).toBe(400);
  expect((await post({ baseRevision: 1 }, "not-a-bot")).status).toBe(400);
  expect((await post({ baseRevision: 1, padding: "x".repeat(70 * 1024) })).status).toBe(413);
  expect(recover).not.toHaveBeenCalled();
  const denied = createBotRoutes({ recovery: { recover }, getPrincipal: () => { throw new MissingRequestPrincipalError(); } });
  expect((await denied.request(`/api/chat-agents/${botId}/recover-managed-custom`, { method: "POST", body: "{}" })).status).toBe(401);
  expect(recover).not.toHaveBeenCalled();
  const failed = await post({ baseRevision: 1 });
  expect(failed.status).toBe(503); expect(await failed.text()).not.toMatch(/private|secret|database/);
});

it.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("serializes concurrent explicit recovery and definition edits on pooled Postgres", async () => {
  const recovered = await Promise.all(Array.from({ length: 8 }, () => recovery.recover(OWNER, botId, { baseRevision: 1 })));
  expect(recovered.every(result => result.chatId === chatId && result.agent.id === botId && result.agent.revision === 2)).toBe(true);
  expect(await state.db.selectFrom("bot_operations").selectAll().execute()).toHaveLength(1);
  expect((await state.db.selectFrom("chat_outbox").selectAll().where("event_type", "=", "chat.updated").execute())).toHaveLength(1);
  await expect(agents.update(owner, botId, { baseRevision: 1, archived: true })).rejects.toMatchObject({ code: "agent_conflict" });
});

it.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("never overwrites a concurrent owner archive across the reservation boundary", async () => {
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; }), locked = new Promise<void>(resolve => { entered = resolve; });
  let first = true;
  const service = setup({ validateSelection: async () => { if (first) { first = false; entered(); await hold; } } });
  const result = service.recover(OWNER, botId, { baseRevision: 1 }).then(value => ({ value }), error => ({ error }));
  await locked;
  let edited = false;
  const edit = agents.update(owner, botId, { baseRevision: 1, archived: true }).then(value => { edited = true; return { value }; }, error => ({ error }));
  try { await edit; expect(edited).toBe(true); }
  finally { release(); }
  const [recovered, archived] = await Promise.all([result, edit]);
  expect(Number("value" in recovered) + Number("value" in archived)).toBe(1);
  const current = (await agents.get(owner, botId))!;
  expect(current.revision).toBe(2);
  if ("value" in archived) { expect(current.archived).toBe(true); expect(current.recipeRef).toBeUndefined(); }
  else expect(current.recipeRef).toEqual({ recipeId: "custom-coordinator", version: "1" });
});

function libraryRoutes() {
  return createChatAgentRoutes({ agents, repository: chats, recovery, recipes,
    context: new ChatAgentContext({ agents, repository: chats, recipes, enabled: () => true }), enabled: () => true,
    catalog: { getCatalog: vi.fn() }, getPrincipal: () => ({ userId: OWNER, source: "jwt" }) });
}

it("projects the original reserved revision after promotion rollback and hides recovery after activation", async () => {
  let transaction = 0;
  const broken = setup({ chats: { withTransaction: work => chats.withTransaction(async repository => {
    const value = await work(repository); if (++transaction === 3) throw new Error("Injected activation rollback"); return value;
  }) } });
  const rows = await preservedRows();
  await expect(broken.recover(OWNER, botId, { baseRevision: 1 })).rejects.toMatchObject({ code: "unavailable" });
  const operationBefore = await state.db.selectFrom("bot_operations").selectAll().execute();
  const fileBefore = await agents.getCreationSnapshot(owner, botId);
  const wire = await libraryRoutes().request("/api/chat-agents?includeManagedCustomRecoveries=true");
  expect(wire.status).toBe(200);
  const library = ChatAgentListResponseSchema.parse(await wire.json());
  expect(library.agents[0]).toMatchObject({ revision: 2, recipeRef: { recipeId: "custom-coordinator" } });
  expect(library).toMatchObject({ managedCustomRecoveries: [{ agentId: botId, baseRevision: 1 }] });
  expect(await state.db.selectFrom("bot_operations").selectAll().execute()).toEqual(operationBefore);
  expect(await agents.getCreationSnapshot(owner, botId)).toEqual(fileBefore);
  expect(await preservedRows()).toEqual(rows);
  await expect(recovery.recover(OWNER, botId, library.managedCustomRecoveries![0])).rejects.toMatchObject({ code: "invalid_request" });
  await expect(recovery.recover(OWNER, botId, { baseRevision: library.managedCustomRecoveries![0]!.baseRevision })).resolves.toMatchObject({ chatId });
  expect(await (await libraryRoutes().request("/api/chat-agents?includeManagedCustomRecoveries=true")).json()).toMatchObject({ managedCustomRecoveries: [] });
  expect(await preservedRows()).toEqual(rows);
});

it.each(["owner", "hash", "request", "binding", "archived", "recipe", "revision"])("omits invalid unfinished recovery projection: %s", async condition => {
  const failed = setup({ ensureWorkspace: async () => { throw new Error("Injected failure"); } });
  await expect(failed.recover(OWNER, botId, { baseRevision: 1 })).rejects.toMatchObject({ code: "unavailable" });
  if (condition === "owner") await state.db.updateTable("bot_operations").set({ owner_id: "foreign-owner" }).execute();
  if (condition === "hash") await state.db.updateTable("bot_operations").set({ payload_hash: "f".repeat(64) }).execute();
  if (condition === "request") await state.db.updateTable("bot_operations").set({ client_request_id: "req_managedcustom_recover_forged" }).execute();
  if (condition === "binding") await state.db.updateTable("bot_chat_bindings").set({ removed_at: NOW }).execute();
  if (condition === "archived") await agents.update(owner, botId, { baseRevision: 1, archived: true });
  if (condition === "recipe") await agents.update(owner, botId, { baseRevision: 1, instructions: "New owner edit" });
  if (condition === "revision") await agents.update(owner, botId, { baseRevision: 1, description: "New description" });
  const response = await libraryRoutes().request("/api/chat-agents?includeManagedCustomRecoveries=true");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ managedCustomRecoveries: [] });
});

it("projects reserved recovery without provider readiness or any workspace mutation", async () => {
  await expect(setup({ ensureWorkspace: async () => { throw new Error("Injected failure"); } }).recover(OWNER, botId, { baseRevision: 1 }))
    .rejects.toMatchObject({ code: "unavailable" });
  const validateSelection = vi.fn(async () => { throw new Error("Provider offline"); }), ensureWorkspace = vi.fn();
  const service = setup({ validateSelection, ensureWorkspace });
  expect(await service.projectUnfinished(OWNER, await agents.list(owner))).toEqual([{ agentId: botId, baseRevision: 1 }]);
  expect(validateSelection).not.toHaveBeenCalled(); expect(ensureWorkspace).not.toHaveBeenCalled();
  const agent = (await agents.get(owner, botId))!;
  expect(await service.projectUnfinished(OWNER, [{ ...agent, recipeRef: { recipeId: "daily-brief", version: "1" } }])).toEqual([]);
});

it("fails a status read safely on infrastructure failure without enabling a fallback projection", async () => {
  const app = createChatAgentRoutes({ agents, repository: chats, recovery: { projectUnfinished: async () => { throw new Error("private database diagnostic"); } },
    context: new ChatAgentContext({ agents, repository: chats, recipes, enabled: () => true }), enabled: () => true,
    catalog: { getCatalog: vi.fn() }, getPrincipal: () => ({ userId: OWNER, source: "jwt" }) });
  const response = await app.request("/api/chat-agents?includeManagedCustomRecoveries=true");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Agents are temporarily unavailable." });
});

it("keeps the default library wire compatible with installed strict clients and validates projection opt-in", async () => {
  const response = await libraryRoutes().request("/api/chat-agents");
  expect(response.status).toBe(200);
  const wire = await response.json();
  expect(ChatAgentListResponseSchema.omit({ managedCustomRecoveries: true }).safeParse(wire).success).toBe(true);
  expect(wire).not.toHaveProperty("managedCustomRecoveries");
  for (const query of ["includeManagedCustomRecoveries=false", "includeManagedCustomRecoveries=true&ownerId=foreign", "includeManagedCustomRecoveries=1"]) {
    expect((await libraryRoutes().request(`/api/chat-agents?${query}`)).status).toBe(400);
  }
});
