import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CanonicalChatRun, ChatRunContext } from "@matrix-os/contracts";
import { bootstrapBotDatabase, type OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { BOT_MIGRATIONS } from "../../../packages/gateway/src/bots/database-migrations.js";
import { createCustomBotChats } from "../../../packages/gateway/src/bots/custom-direct-chat.js";
import { BotRuntimeRegistry } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { ChatAgentStore } from "../../../packages/gateway/src/chat/agent-store.js";
import { ChatAgentContext } from "../../../packages/gateway/src/chat/agent-context.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { admitCanonicalRetry } from "../../../packages/gateway/src/chat/retry-admission.js";
import { CanonicalChatProviderRegistry, type CanonicalChatProviderAdapter } from "../../../packages/gateway/src/chat/provider-adapter.js";
import { createCanonicalChatRoutes, type CanonicalChatRouteService } from "../../../packages/gateway/src/chat/routes.js";
import { createManagedPiAdmission } from "../../../packages/gateway/src/chat/managed-pi-admission.js";
import { resolveManagedPiRoute } from "../../../packages/gateway/src/bots/route-resolver.js";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";
import { createCanonicalChatFixture } from "../../contracts/fixtures/canonical-chat.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import { BOT, NOW, OWNER, createBotStateDatabase } from "./bot-state-support.js";
import { migrateDeployedBotThreadsV9 } from "./fixtures/bot-threads-schema-v9.js";

const owner = { type: "personal" as const, ownerId: OWNER };
let db: Kysely<OwnerBotDatabase>, destroy: () => Promise<void>, home: string;
let repository: ChatRepository, agents: ChatAgentStore, context: ChatAgentContext;
beforeEach(async () => {
  ({ db, destroy } = await createBotStateDatabase({ migrate: false }));
  await bootstrapBotDatabase(db, [...BOT_MIGRATIONS.slice(0, 8), { version: 9, name: "bot_chat_threads", up: migrateDeployedBotThreadsV9 }]);
  home = await mkdtemp(join(tmpdir(), "matrix-v9-retry-")); repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  agents = new ChatAgentStore({ homePath: home, db: repository.kysely }); await agents.bootstrap();
  context = new ChatAgentContext({ repository, agents, enabled: () => true, botChats: createCustomBotChats({ chats: repository, agents }) });
});
afterEach(async () => { await agents.close(); await destroy(); await rm(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

async function historicalRun(savedContext?: ChatRunContext, managed = false) {
  const fixture = createCanonicalChatFixture("accepted"); const chatId = fixture.snapshot.chat.id;
  const record = await repository.create(owner, { id: chatId, clientRequestId: "req_retained_v9", title: "Retained history" });
  const { executionRoot: _root, executionRootFingerprint: _fingerprint, ...original } = fixture.snapshot.runs[0]!;
  const run: CanonicalChatRun = { ...original, ...(savedContext ? { context: savedContext } : {}), ...(managed ? {
    driverKind: "matrix_pi" as const, instanceId: "matrix_pi_default", selection: { instanceId: "matrix_pi_default", model: "claude-sonnet-5" },
  } : {}) };
  await repository.admitTurn(owner, { chatId, baseRevision: record.chat.revision,
    message: fixture.snapshot.messages[0]!, turn: fixture.snapshot.turns[0]!, run });
  return { chatId, run, turn: fixture.snapshot.turns[0]! };
}
const preserved = async () => Promise.all(["bot_chat_bindings", "chats", "chat_messages", "chat_turns", "chat_runs"].map(async table =>
  (await sql`SELECT * FROM ${sql.table(table)} ORDER BY 1`.execute(db)).rows));

it.each(["undefined", "history-only"] as const)("refuses retained-thread retry with %s context before catalog, persistence or dispatch", async variant => {
  const saved: ChatRunContext | undefined = variant === "undefined" ? undefined : { version: 1, requestHash: "a".repeat(64), chats: [],
    history: { chatId: "chat_fixture_accepted", title: "Retained history", throughSeq: 1, text: "User: retained request", truncated: false } };
  const { chatId, run, turn } = await historicalRun(saved);
  await repository.finishRun(owner, { chatId, runId: run.id, outcome: "failed", completedAt: NOW });
  await sql`INSERT INTO bot_chat_bindings(owner_id,bot_id,chat_id,kind,project_id,created_at)
    VALUES (${OWNER},${BOT},${chatId},'thread','proj_retained',${NOW})`.execute(db);
  const before = await preserved(); const snapshot = createCanonicalChatFixture("accepted");
  const getCatalog = vi.fn(async () => snapshot.providerCatalog), startDispatch = vi.fn();
  const persist = vi.spyOn(repository, "admitRetry"), reserve = vi.fn();
  const adapter: CanonicalChatProviderAdapter = { driverKind: "codex", stateSchemaVersion: 1, parseState: value => value, serializeState: value => value,
    start: async function* () { yield { type: "run.completed", outcome: "completed" }; },
    resume: async function* () { yield { type: "run.completed", outcome: "completed" }; } };
  const service = { retryTurn: (principal, resolvedOwner, id, turnId, input) => admitCanonicalRetry({
    repository, agentContext: context, catalog: { getCatalog }, adapters: new CanonicalChatProviderRegistry([adapter]),
    assertOpen: () => {}, assertPersonalExecutionAllowed: async () => {}, reconcileActiveRuns: async () => {},
    reservePendingDispatch: reserve, releasePendingDispatch: () => {}, atCapacity: () => false,
    hasStoppingExecution: () => false, startDispatch,
  }, principal, resolvedOwner, id, turnId, input) } as CanonicalChatRouteService;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const app = new Hono().route("/", createCanonicalChatRoutes({ service, getPrincipal: () => ({ userId: OWNER, source: "jwt" }) }));
  const response = await app.request(`/api/chats/${chatId}/turns/${turn.id}/runs`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId: `req_v9_retry_${variant}`, baseRevision: (await repository.get(owner, chatId))!.chat.revision }) });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { code: "service_unavailable", safeMessage: "Chat is temporarily unavailable.", retryable: true, recoveryActions: ["retry"] } });
  expect(getCatalog).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled(); expect(startDispatch).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled();
  expect(await preserved()).toEqual(before);
});

it("permits an ordinary managed Chat with only removed thread history through actual v9 admission and runtime registry", async () => {
  const { chatId, run } = await historicalRun(undefined, true);
  await sql`INSERT INTO bot_chat_bindings(owner_id,bot_id,chat_id,kind,project_id,created_at,removed_at)
    VALUES (${OWNER},${BOT},${chatId},'thread','proj_retained',${NOW},${NOW})`.execute(db);
  await expect(context.revalidate(owner, chatId)).resolves.toBeUndefined();
  await expect(createCustomBotChats({ chats: repository, agents }).directBot(owner, chatId)).resolves.toBeNull();
  const before = await preserved(), registry = new BotRuntimeRegistry();
  const createRuntime = vi.fn(async () => ({ runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1" }));
  const stopRuntime = vi.fn(async () => undefined);
  const host = { available: true, client: { createRuntime, stopRuntime } } as unknown as ScopeRuntimeHost;
  const admission = createManagedPiAdmission({ db, homePath: home, host, registry, roots: { resolve: vi.fn() } });
  const binding = await admission.admit({ ownerId: OWNER, chatId, runId: run.id,
    resolved: resolveManagedPiRoute(makeAiProviderSnapshot(), run.selection) });
  try {
    expect(createRuntime).toHaveBeenCalledTimes(1); expect(binding.kind).toBe("managed_chat");
    expect(registry.lookupRun(binding)).toEqual(binding); expect(await preserved()).toEqual(before);
  } finally { await admission.release(binding.runtimeHandle); registry.shutdown(); }
  expect(stopRuntime).toHaveBeenCalledOnce(); expect(registry.size).toBe(0); expect(await preserved()).toEqual(before);
});
