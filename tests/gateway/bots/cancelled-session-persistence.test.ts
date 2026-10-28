import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createBotWorker } from "../../../packages/bot-runtime/src/worker.js";
import { BotBrokerError } from "../../../packages/bot-runtime/src/broker-client.js";
import { createBotBrokerActions } from "../../../packages/gateway/src/bots/broker-actions.js";
import { BotRuntimeRegistry, type PiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { createBotTaskOrchestrator } from "../../../packages/gateway/src/bots/task-orchestrator.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotSessionsRepository } from "../../../packages/gateway/src/bots/repositories/sessions.js";
import { createBotCheckpointsRepository } from "../../../packages/gateway/src/bots/repositories/checkpoints.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createManagedPiSessionsRepository } from "../../../packages/gateway/src/chat/managed-pi-sessions.js";
import { createManagedPiRuntime } from "../../../packages/gateway/src/chat/managed-pi-runtime.js";
import { resolveManagedPiRoute } from "../../../packages/gateway/src/bots/route-resolver.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { MATRIX_BOT_SELECTION } from "../../../packages/gateway/src/bots/selection.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import { BOT, OWNER, createBotStateDatabase, insertChat } from "./bot-state-support.js";
import type { Kysely } from "kysely";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import type { ScopeRuntimeHost, ScopeRuntimeHostClient } from "../../../packages/gateway/src/scope-runtime-host/index.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.restoreAllMocks(); });

// Detects early registry release at the real worker -> broker -> Postgres boundary.
// Only the external command socket is replaced; its abort rejects the pending RPC.
it.each(["recipe", "managed"] as const)("preserves the %s worker's terminal checkpoint after Stop, without accepting late success", async kind => {
  const { db, destroy } = await createBotStateDatabase(); cleanup.push(destroy);
  const chatId = "chat_stop_save", runId = "run_stop_save";
  await insertChat(db, chatId);
  const registry = new BotRuntimeRegistry(); cleanup.push(async () => registry.shutdown());
  const runtime = { runtimeHandle: `runtime_${"c".repeat(32)}`, executionGeneration: "4", rootFingerprint: "c".repeat(64) };
  const snapshot = makeAiProviderSnapshot();
  const selection = { instanceId: "matrix_pi_default", model: "claude-sonnet-5" };
  const resolved = resolveManagedPiRoute(snapshot, selection);
  const faux = fauxProvider({ models: [{ id: resolved.route.modelId, input: ["text"], contextWindow: resolved.route.contextWindow, maxTokens: resolved.route.maxOutputTokens }] });
  faux.appendResponses([fauxAssistantMessage(fauxText("CHECKPOINT_REPLY")), context => {
    expect(JSON.stringify(context.messages)).toContain("CHECKPOINT_REPLY");
    return fauxAssistantMessage(fauxText("NEXT_REPLY"));
  }]);
  const saving = deferred(), allowSave = deferred();
  cleanup.push(async () => { allowSave.resolve(); });
  let binding!: PiRuntimeBinding;
  let actions!: ReturnType<typeof createBotBrokerActions>;
  const call = async (currentRunId: string, body: Record<string, unknown>) => {
    const reply = await actions.handleFrame({ version: 1, requestId: randomUUID(), runtimeHandle: runtime.runtimeHandle, executionGeneration: runtime.executionGeneration, runId: currentRunId, ...body });
    if (!reply?.ok) throw new BotBrokerError((reply?.code ?? "unavailable") as never);
    return reply.result;
  };
  const worker = createBotWorker({ bridgeOrigin: "http://127.0.0.1:41000", route: { provider: faux.provider, model: faux.getModel() }, brokerFor: currentRunId => ({
    loadRun: () => call(currentRunId, { action: "bot.run.load" }) as never,
    readImageChunk: image => call(currentRunId, { action: "bot.input.image", image }) as never,
    loadSession: () => call(currentRunId, { action: "bot.session.load" }) as never,
    saveSession: async session => { saving.resolve(); await allowSave.promise; return call(currentRunId, { action: "bot.session.save", session }) as never; },
    event: async event => { await call(currentRunId, { action: "bot.event", event }); },
    tool: tool => call(currentRunId, { action: "bot.tool", tool }) as never,
  }) });
  let workerDone: Promise<unknown> | undefined;
  const runBot: ScopeRuntimeHostClient["runBot"] = async request => {
    const pending = worker.handle(request.command).then(reply => ({ ok: true as const, reply }));
    if (request.command.kind !== "bot.run") return pending;
    workerDone = pending;
    return new Promise((resolve, reject) => {
      const aborted = () => reject(new DOMException("Command cancelled", "AbortError"));
      request.signal?.addEventListener("abort", aborted, { once: true });
      if (request.signal?.aborted) aborted();
      pending.then(resolve, reject).finally(() => request.signal?.removeEventListener("abort", aborted));
    });
  };
  const release = vi.fn(async () => { registry.release(runtime.runtimeHandle); });
  const startRenewal = () => ({ stop: async () => undefined });
  const sessions = createBotSessionsRepository(db), managedSessions = createManagedPiSessionsRepository(db);
  let stop!: () => Promise<void>, terminal!: Promise<unknown>;
  let startAgain!: () => Promise<unknown>;
  let runs!: Parameters<typeof createBotBrokerActions>[0]["runs"];
  let events!: Parameters<typeof createBotBrokerActions>[0]["events"];
  if (kind === "recipe") {
    const bindings = createBotBindingsRepository(db);
    await bindings.bindDirect({ ownerId: OWNER, botId: BOT, chatId, now: new Date().toISOString() });
    const orchestrator = createBotTaskOrchestrator({ bindings, registry, client: { runBot },
      transact: createBotStateTransactions(new ChatRepository(db as unknown as Kysely<ChatDatabase>)), recipes: createBotRecipeCatalog(),
      agents: { get: async () => ({ id: BOT, name: "Writing Bot", description: "", instructions: "Revise prose", archived: false, selection: MATRIX_BOT_SELECTION,
        recipeRef: { recipeId: "writing-bot", version: "2026-09-27.1" }, revision: 1, createdAt: "2026-09-27T12:00:00.000Z", updatedAt: "2026-09-27T12:00:00.000Z" }) },
      resolveRoute: async () => resolved,
      admission: { admit: async request => {
        const { expectedRootFingerprint: _fingerprint, signal: _signal, ...identity } = request;
        binding = { ...identity, ...runtime }; registry.bind(binding); return runtime;
      }, release, startRenewal },
    });
    runs = orchestrator.runSource; events = orchestrator.eventSink;
    stop = () => orchestrator.cancel(runId);
    // Starts after actions is assigned below.
    terminal = Promise.resolve().then(() => orchestrator.start({ ownerId: OWNER, chatId, runId, text: "CHECKPOINT_PROMPT", signal: new AbortController().signal }).result);
    startAgain = () => orchestrator.start({ ownerId: OWNER, chatId, runId: "run_after_stop", text: "NEXT_PROMPT", signal: new AbortController().signal }).result;
  } else {
    const managed = createManagedPiRuntime({ providers: { getSnapshot: async () => snapshot }, lifetime: new AbortController().signal,
      host: { client: { runBot } } as unknown as ScopeRuntimeHost, forgetRun: () => undefined, cancelInference: current => registry.cancelInference(current),
      admission: { admit: async request => {
        const current = { kind: "managed_chat" as const, ownerId: OWNER, chatId, runId: request.runId, ...runtime, workspace: { kind: "chat_workspace" as const }, ...resolved, capabilities: ["artifact.read" as const], requestClass: "interactive" as const };
        binding = current; registry.bind(current); return current;
      }, release, startRenewal, workspace: async () => "/owned/chat", toolAuthority: async () => ({ permissionMode: "supervised" }) },
    });
    runs = managed.runs; events = managed.events;
    stop = () => managed.adapter.cancel!({ owner: { type: "personal", ownerId: OWNER }, chatId, runId });
    const start = async (currentRunId: string, prompt: string) => {
      const collected = [];
      for await (const event of managed.adapter.start({ owner: { type: "personal", ownerId: OWNER }, chatId, runId: currentRunId, turnId: `cturn_${currentRunId}`, prompt,
        parts: [{ type: "text", text: prompt }], selection, interactionMode: "default", permissionMode: "supervised", signal: new AbortController().signal })) collected.push(event);
      return collected.at(-1);
    };
    terminal = Promise.resolve().then(() => start(runId, "CHECKPOINT_PROMPT"));
    startAgain = () => start("run_after_stop", "NEXT_PROMPT");
  }
  actions = createBotBrokerActions({ db, registry, sessions, managedSessions, checkpoints: createBotCheckpointsRepository(db), runs, events,
    tools: { effectClass: () => "read", dispatch: async () => { throw new Error("No tools allowed"); } },
    inference: { homePath: "/owned", lifetime: new AbortController().signal } });
  await Promise.race([saving.promise, terminal.then(() => { throw new Error("Worker ended before checkpoint"); })]);
  const inferenceSignal = registry.inferenceSignal(binding)!;
  await stop();
  expect(await terminal).toMatchObject(kind === "recipe" ? { status: "cancelled" } : { type: "run.completed", outcome: "aborted" });
  expect(inferenceSignal.aborted).toBe(true);
  await expect(runs.loadRunSpec(binding)).rejects.toMatchObject({ code: "stale_generation" });
  await expect(events.publish(binding, { seq: 999, event: { type: "assistant_delta", text: "LATE_SUCCESS" } })).rejects.toMatchObject({ code: "stale_generation" });
  const stoppedWorker = workerDone;
  const next = startAgain();
  // Let the next turn reach admission while the stopped worker is still saving.
  await new Promise<void>(resolve => setImmediate(resolve));
  allowSave.resolve();
  await stoppedWorker;
  expect(await next).toMatchObject(kind === "recipe" ? { status: "completed" } : { type: "run.completed", outcome: "completed" });
  const saved = kind === "recipe" ? await sessions.load({ ownerId: OWNER, botId: BOT, chatId }) : await managedSessions.load({ ownerId: OWNER, chatId });
  expect(saved.revision).toBe(2);
  expect(JSON.stringify(saved.messages)).toContain("CHECKPOINT_PROMPT");
  expect(JSON.stringify(saved.messages)).toContain("CHECKPOINT_REPLY");
  expect(JSON.stringify(saved.messages)).toContain("NEXT_REPLY");
  await vi.waitFor(() => expect(registry.lookupRun(binding)).toBeNull());
  expect(release).toHaveBeenCalledTimes(2);
});
