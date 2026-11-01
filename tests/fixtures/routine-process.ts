/** Built qualification process: real scheduler/Chat/Bot/Pi/PG, synthetic external authority/model. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { KyselyPGlite } from "kysely-pglite";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { MATRIX_BOT_SELECTION, type ChatAgent } from "@matrix-os/contracts";
import { bootstrapChatDatabase, type ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CanonicalChatOrchestrator } from "../../packages/gateway/src/chat/orchestrator.js";
import { CanonicalChatProviderRegistry } from "../../packages/gateway/src/chat/provider-adapter.js";
import { bootstrapBotDatabase, type OwnerBotDatabase } from "../../packages/gateway/src/bots/database.js";
import { createBotStateTransactions } from "../../packages/gateway/src/bots/events.js";
import { createBotBindingsRepository } from "../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotTasksRepository } from "../../packages/gateway/src/bots/repositories/tasks.js";
import { createBotSessionsRepository } from "../../packages/gateway/src/bots/repositories/sessions.js";
import { createBotCheckpointsRepository } from "../../packages/gateway/src/bots/repositories/checkpoints.js";
import { createBotRoutinesRepository } from "../../packages/gateway/src/bots/repositories/routines.js";
import { createBotInteractionsRepository } from "../../packages/gateway/src/bots/repositories/interactions.js";
import { createBotRoutineApprovals } from "../../packages/gateway/src/bots/routine-approval.js";
import { createBotRoutineExecution } from "../../packages/gateway/src/bots/routine-execution.js";
import { createBotInteractionService } from "../../packages/gateway/src/bots/interactions.js";
import { createBotTaskOrchestrator } from "../../packages/gateway/src/bots/task-orchestrator.js";
import { createMatrixBotChatProviderAdapter } from "../../packages/gateway/src/bots/chat-adapter.js";
import { BotRuntimeRegistry, type BotRuntimeBinding } from "../../packages/gateway/src/bots/runtime-registry.js";
import { createBotRecipeCatalog } from "../../packages/gateway/src/bots/recipe-catalog.js";
import { withBotProviderInstance } from "../../packages/gateway/src/bots/provider-instance.js";
import { createBotBrokerActions, BotBrokerActionError } from "../../packages/gateway/src/bots/broker-actions.js";
import { createScopeRuntimeBrokerServer } from "../../packages/gateway/src/collaboration/scope-runtime-broker.js";
import { createBotBrokerClient } from "../../packages/bot-runtime/src/broker-client.js";
import { createBotWorker } from "../../packages/bot-runtime/src/worker.js";

const OWNER = "user_routine_process", BOT = "bot_0123456789abcdef", CHAT = "chat_routine_process";
const schema = process.env.MATRIX_ROUTINE_SCHEMA ?? "";
const dataDir = process.env.MATRIX_ROUTINE_PGLITE_DIR;
if (!process.env.MATRIX_ROUTINE_PROCESS_HOME) throw new Error("Dedicated temporary home required");
if (dataDir && (!resolve(dataDir).startsWith(`${resolve(tmpdir())}/rp-db-`) || process.env.MATRIX_ROUTINE_PGLITE_TEST !== "1")) throw new Error("Dedicated temporary PGlite directory required");
const url = dataDir ? undefined : new URL(process.env.MATRIX_TEST_POSTGRES_URL ?? "invalid:");
if (url && (!/^bots_[a-f0-9]{32}$/.test(schema) || url.hostname !== "127.0.0.1" || !url.pathname.includes("test"))) throw new Error("Dedicated loopback test database required");
const dialect = dataDir ? (await KyselyPGlite.create(dataDir)).dialect : new PostgresDialect({ pool: new pg.Pool({
  connectionString: url!.toString(), max: 4, options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000`,
}) });
const db = new Kysely<OwnerBotDatabase>({ dialect });
await bootstrapChatDatabase(db);
await bootstrapBotDatabase(db);
if (process.env.MATRIX_ROUTINE_EXPIRE_FIRE) {
  if (!/^fire_[a-f0-9]{24}$/.test(process.env.MATRIX_ROUTINE_EXPIRE_FIRE)) throw new Error("Invalid synthetic fire");
  await db.updateTable("bot_routine_fires").set({ lease_expires_at: new Date(Date.now() - 1000).toISOString() })
    .where("fire_id", "=", process.env.MATRIX_ROUTINE_EXPIRE_FIRE).execute();
}
const chats = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
const owner = { type: "personal" as const, ownerId: OWNER };
const transact = createBotStateTransactions(chats), tasks = createBotTasksRepository(db);
const routinesRepo = createBotRoutinesRepository(db), sessions = createBotSessionsRepository(db);
const registry = new BotRuntimeRegistry(), lifetime = new AbortController();
const subscription = { accountId: "synthetic_account", computerId: "synthetic_computer", grantRevision: 1,
  peerId: "f2b7ba8f-009b-4603-8967-c3e6bdfb276e" };
const route = { api: "openai-responses" as const, modelId: "fixture-model", input: ["text" as const], contextWindow: 8192, maxOutputTokens: 256 };
const approvals = createBotRoutineApprovals({ db, transact, definitionRevision: async () => 1, source: {
  resolve: async (selection, ownerId, requestClass) => {
    if (ownerId !== OWNER || requestClass !== "routine" || selection?.model !== route.modelId
      || selection.options?.find(o => o.id === "accountId")?.value !== subscription.accountId
      || selection.options?.find(o => o.id === "grantRevision")?.value !== "1") throw new Error("Synthetic source refused");
    return { route, subscription, accessSourceId: "matrix_chatgpt_plan" as const };
  },
} });
const execution = createBotRoutineExecution({ db, approvals, transact });
const agent: ChatAgent = { id: BOT, name: "Synthetic writing bot", description: "", instructions: "Revise the synthetic text.",
  archived: false, selection: MATRIX_BOT_SELECTION, recipeRef: { recipeId: "writing-bot", version: "2026-09-27.1" },
  revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const slow = process.env.MATRIX_ROUTINE_PROCESS_SLOW === "1";
const faux = fauxProvider({ tokensPerSecond: slow ? 1 : 1_000_000, models: [{ id: "fixture-model", input: ["text"] }] });
const socketPath = join(process.env.MATRIX_ROUTINE_PROCESS_HOME, "broker.sock");
const workers = new Map<string, ReturnType<typeof createBotWorker>>(); // At most 4; release deletes and shutdown drains.
const taskOrchestrator = createBotTaskOrchestrator({
  expectedOwnerId: OWNER, bindings: createBotBindingsRepository(db), transact,
  routineExecution: execution,
  agents: { get: async scope => scope.ownerId === OWNER ? agent : null }, recipes: createBotRecipeCatalog(),
  resolveRoute: async (_selection, requestClass) => {
    if (requestClass !== "routine") throw new Error("Only synthetic scheduled execution allowed");
    return { route, subscription, accessSourceId: "matrix_chatgpt_plan" as const };
  },
  assertSource: async binding => { await execution.assertBinding(binding as BotRuntimeBinding); },
  registry,
  admission: {
    // Scope-host admission/renewal remains an explicit double in this local process lane.
    startRenewal: () => ({ stop: async () => undefined }),
    admit: async request => {
      if (request.group || request.ownerId !== OWNER) throw new Error("Only synthetic personal admission allowed");
      if (workers.size >= 4) throw new Error("Synthetic runtime capacity exceeded");
      const runtimeHandle = `runtime_${randomUUID().replaceAll("-", "")}`, executionGeneration = "1", rootFingerprint = "a".repeat(64);
      const { expectedRootFingerprint: _root, signal: _signal, group: _group, ...binding } = request;
      registry.bind({ ...binding, runtimeHandle, executionGeneration, rootFingerprint });
      faux.setResponses([context => {
        const system = context.messages.find(message => message.role === "system");
        const text = typeof system?.content === "string" ? system.content : system?.content.map(part => part.type === "text" ? part.text : "").join("") ?? "";
        if (!text.includes("Current routine phase (verified by Matrix for this run):")) throw new Error("Compiled process omitted verified routine phase");
        return fauxAssistantMessage(fauxText(slow ? "pending ".repeat(1000) : "Verified scheduled Pi result."));
      }]);
      workers.set(runtimeHandle, createBotWorker({ bridgeOrigin: "http://127.0.0.1:1", route: { provider: faux.provider, model: faux.getModel() },
        brokerFor: runId => createBotBrokerClient({ socketPath, runtimeHandle, executionGeneration, runId }) }));
      return { runtimeHandle, executionGeneration, rootFingerprint };
    },
    release: async runtimeHandle => {
      await workers.get(runtimeHandle)?.shutdown(); workers.delete(runtimeHandle); registry.release(runtimeHandle);
    },
  },
  client: { runBot: async input => {
    const worker = workers.get(input.runtimeHandle);
    if (!worker) throw new Error("Synthetic runtime missing");
    return { ok: true as const, reply: await worker.handle(input.command) };
  } },
});
const actions = createBotBrokerActions({ db, registry, sessions, checkpoints: createBotCheckpointsRepository(db),
  runs: taskOrchestrator.runSource, events: taskOrchestrator.eventSink,
  tools: { effectClass: () => "read", dispatch: async () => { throw new BotBrokerActionError("not_granted"); } },
  inference: { homePath: process.env.MATRIX_ROUTINE_PROCESS_HOME, lifetime: lifetime.signal,
    fetchImpl: async () => { throw new Error("External inference prohibited in qualification"); } },
});
const broker = createScopeRuntimeBrokerServer({ socketPath, maxConnections: 8,
  broker: { handle: async () => { throw new Error("Non-Bot frame refused"); }, close() {} }, routeFrame: actions.handleFrame });
await broker.start();
const adapter = createMatrixBotChatProviderAdapter({ orchestrator: taskOrchestrator, routines: execution,
  stopRuntime: async handle => { await workers.get(handle)?.shutdown(); workers.delete(handle); registry.release(handle); } });
const canonical = new CanonicalChatOrchestrator({ repository: chats, adapters: new CanonicalChatProviderRegistry([adapter]),
  catalog: withBotProviderInstance({ getCatalog: async () => ({ revision: "synthetic", drivers: [], instances: [] }) }) });
execution.connect({ repository: chats, orchestrator: canonical });
let started = false, closing = false;
async function handle(value: { op: string; at?: string; routineId?: string; status?: "active" | "paused" | "archived"; foreign?: boolean }) {
  if (value.op === "seed") {
    await chats.create(owner, { id: CHAT, clientRequestId: "req_process_create", title: "Synthetic process qualification" });
    await createBotBindingsRepository(db).bindDirect({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: new Date().toISOString() });
    const task = await tasks.create({ ownerId: OWNER, botId: BOT, chatId: CHAT, now: new Date().toISOString() });
    await tasks.transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: task.revision, to: "running", runId: "run_process_proposal", now: new Date().toISOString() });
    const pending = await approvals.propose({ ownerId: OWNER, botId: BOT, chatId: CHAT, taskId: task.taskId,
      runId: "run_process_proposal", runtimeHandle: `runtime_${"f".repeat(32)}`, executionGeneration: "1", rootFingerprint: "a".repeat(64),
      route, subscription, accessSourceId: "matrix_chatgpt_plan", requestClass: "interactive", capabilities: [] },
    { name: "Synthetic timed task", prompt: "Revise the synthetic paragraph.", schedule: { kind: "once", at: value.at },
      selection: { instanceId: "matrix_chatgpt_plan", model: route.modelId }, authorizedEffects: ["read"] });
    const interaction = await createBotInteractionsRepository(db).get({ ownerId: OWNER, interactionId: pending.interactionId });
    const interactions = createBotInteractionService({ transact, handlers: { chooseAccount: async () => { throw new Error("No external account"); }, decideApproval: approvals.decide } });
    await interactions.resolve(OWNER, CHAT, pending.interactionId, { kind: "approval", decision: "approve", baseRevision: interaction!.revision });
    await tasks.transition({ ownerId: OWNER, taskId: task.taskId, baseRevision: 2, to: "completed", now: new Date().toISOString() });
    return (await execution.list(OWNER, BOT))[0];
  }
  if (value.op === "start") {
    if (started) throw new Error("Already started");
    started = true; await canonical.reconcileActiveRuns(owner); await execution.start({ repository: chats, orchestrator: canonical });
    return { pid: process.pid };
  }
  if (value.op === "control") {
    const current = await routinesRepo.get(OWNER, value.routineId!);
    return execution.control(value.foreign ? "user_other_process" : OWNER, BOT, value.routineId!, { baseRevision: current!.revision, status: value.status! });
  }
  if (value.op === "approve_future_time") {
    if (value.foreign || !value.at) throw new Error("Owner future time required");
    const current = (await routinesRepo.get(OWNER, value.routineId!))!;
    const pending = await execution.requestEdit(OWNER, current.routineId, { baseRevision: current.revision,
      name: current.proposal.name, prompt: current.proposal.prompt, schedule: { kind: "once", at: value.at } });
    const interactions = createBotInteractionService({ transact, handlers: { chooseAccount: async () => { throw new Error("No external account"); }, decideApproval: approvals.decide } });
    await interactions.resolve(OWNER, CHAT, pending.interaction.interactionId,
      { kind: "approval", decision: "approve", baseRevision: pending.interaction.revision });
    return (await execution.list(OWNER, BOT))[0];
  }
  if (value.op === "snapshot") {
    const ownerId = value.foreign ? "user_other_process" : OWNER;
    const ids = await db.selectFrom("bot_tasks").select("task_id").where("chat_id", "=", CHAT).execute();
    const scoped = await Promise.all(ids.map(row => tasks.get({ ownerId, taskId: row.task_id })));
    const known = (await routinesRepo.list(OWNER, BOT))[0];
    return { routines: await execution.list(ownerId, BOT), providerCalls: faux.state.callCount,
      fires: known ? await routinesRepo.fires(ownerId, known.routineId) : [],
      tasks: scoped.filter(task => task !== undefined).map(task => ({ task_id: task.taskId, status: task.status, run_id: task.runId })),
      chat: await chats.exportChat({ ...owner, ownerId }, CHAT),
      session: await sessions.load({ ownerId, botId: BOT, chatId: CHAT }) };
  }
  throw new Error("Unknown fixture operation");
}
async function shutdown() {
  if (closing) return; closing = true;
  await execution.stop(); await canonical.close();
  for (const worker of workers.values()) await worker.shutdown(); workers.clear();
  lifetime.abort(); await broker.close(); await db.destroy(); process.disconnect?.();
}
let pending = Promise.resolve();
process.on("message", (message: { id: number; request: Parameters<typeof handle>[0] }) => {
  pending = pending.then(async () => {
    try { process.send?.({ id: message.id, result: await handle(message.request) }); }
    catch (error: unknown) { process.send?.({ id: message.id, error: error instanceof Error ? error.name : "UnknownError" }); }
  });
});
process.on("SIGTERM", () => { void pending.then(shutdown).catch(error => { console.error(error); process.exitCode = 1; }); });
process.on("disconnect", () => { void pending.then(shutdown).catch(error => { console.error(error); process.exitCode = 1; }); });
process.send?.({ ready: true, pid: process.pid });
