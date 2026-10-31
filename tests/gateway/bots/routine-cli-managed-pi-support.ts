import { randomBytes } from "node:crypto";
import { runBotTurn } from "../../../packages/bot-runtime/src/loop.js";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } from "@earendil-works/pi-ai";
import { createBotBrokerClient } from "../../../packages/bot-runtime/src/broker-client.js";
import { createScopeRuntimeBrokerServer } from "../../../packages/gateway/src/collaboration/scope-runtime-broker.js";
import { createManagedPiAdmission } from "../../../packages/gateway/src/chat/managed-pi-admission.js";
import { createManagedPiRuntime } from "../../../packages/gateway/src/chat/managed-pi-runtime.js";
import { createManagedPiCheckpointsRepository } from "../../../packages/gateway/src/chat/managed-pi-checkpoints.js";
import { createManagedPiSessionsRepository } from "../../../packages/gateway/src/chat/managed-pi-sessions.js";
import { createBotCheckpointsRepository } from "../../../packages/gateway/src/bots/repositories/checkpoints.js";
import { createBotSessionsRepository } from "../../../packages/gateway/src/bots/repositories/sessions.js";
import { createBotBrokerActions } from "../../../packages/gateway/src/bots/broker-actions.js";
import { createBotToolDispatcher } from "../../../packages/gateway/src/bots/tool-dispatcher.js";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import type { ScopeRuntimeHost } from "../../../packages/gateway/src/scope-runtime-host/index.js";
import { makeAiProviderSnapshot } from "../../fixtures/ai-provider-snapshot.js";
import { claudeFixture } from "./routine-cli-claude-support.js";
import type { RoutineCliOperation, BotToolResult, BotEvent } from "@matrix-os/contracts";
/** Named supervisor/process and model fixtures. Actual admission, managed binding, model-facing
 * pinned Pi worker loop/tool, typed Unix socket broker, CLI/IPC/Hono/Postgres and canonical target are real. */
export async function managedPiFixture(operation: RoutineCliOperation, options: { hold?: boolean; omitAuthority?: boolean } = {}) {
  const f = await claudeFixture({ sourceDriver: "matrix_pi" }), lifetime = new AbortController();
  const socketPath = `/tmp/mpi-${randomBytes(8).toString("hex")}.sock`;
  let workerLoopSettled = false;
  let resolveWorker!: () => void, result: BotToolResult | undefined;
  const held = new Promise<void>(resolve => { resolveWorker = resolve; });
  const model = fauxProvider({ models: [{ id: "claude-sonnet-5", input: ["text"], contextWindow: 128000, maxTokens: 8192 }] });
  model.setResponses([fauxAssistantMessage(fauxToolCall("matrix_routines", operation, { id: "call_managed_routine" }), { stopReason: "toolUse" }), fauxAssistantMessage(fauxText("Observed routine result."))]);
  const bindings: ManagedPiRuntimeBinding[] = [];
  const controls: AbortController[] = [];
  const workerEvents: BotEvent["event"][] = []; // Named fixture observation only, capped256; actual managed sink always runs.
  const host: ScopeRuntimeHost = { available: true, client: {
    createRuntime: async () => ({ runtimeHandle: `runtime_${randomBytes(16).toString("hex")}`, executionGeneration: "1" }),
    renewRuntime: async () => undefined, stopRuntime: async () => undefined,
    runBot: async (request: { runtimeHandle: string; executionGeneration: string; command: { kind: string; runId: string } }) => {
      if (request.command.kind !== "bot.run") { resolveWorker(); return { ok: true, reply: {} }; }
      const binding = f.f.registry.lookupRun({ ...request, runId: request.command.runId });
      if (!binding || !("kind" in binding)) throw new Error("No actual managed registration");
      bindings.push(binding);
      const broker = createBotBrokerClient({ socketPath, ...binding });
      const spec = await broker.loadRun();
      const control = new AbortController(); controls.push(control);
      const reply = await runBotTurn({ command: { ...spec, version: 1, kind: "bot.run", runId: binding.runId },
        broker: { ...broker, async tool(request, signal) { const observed = await broker.tool(request, signal); result = observed; return observed; } },
        signal: control.signal, bridgeOrigin: "http://127.0.0.1:41000", route: { provider: model.provider, model: model.getModel() } });
      workerLoopSettled = true;
      if (options.hold) await held;
      return { ok: true, reply };
    },
  } } as unknown as ScopeRuntimeHost;
  const admission = createManagedPiAdmission({ db: f.data.db, homePath: f.f.home, host, registry: f.f.registry,
    roots: { resolve: async () => { throw new Error("No project fixture"); } }, toolCapabilities: options.omitAuthority ? [] : ["routine.cli"] });
  const managed = createManagedPiRuntime({ admission, host, homePath: f.f.home, providers: { getSnapshot: async () => makeAiProviderSnapshot() },
    lifetime: lifetime.signal, routineCli: { runtime: f.runtime, ...f.transport }, routineSignal: binding => f.f.registry.inferenceSignal(binding),
    forgetRun: runId => actions.forgetRun(runId), cancelInference: binding => f.f.registry.cancelInference(binding) });
  const actions = createBotBrokerActions({ db: f.data.db, registry: f.f.registry,
    sessions: createBotSessionsRepository(f.data.db), checkpoints: createBotCheckpointsRepository(f.data.db),
    managedSessions: createManagedPiSessionsRepository(f.data.db), managedCheckpoints: createManagedPiCheckpointsRepository(f.data.db),
    runs: managed.runs, events: { async publish(binding, event) {
      await managed.events.publish(binding, event);
      if (workerEvents.length >= 256) throw new Error("Named worker event observation cap");
      workerEvents.push(structuredClone(event.event));
    } },
    tools: createBotToolDispatcher({ homePath: f.f.home, managedWorkspace: admission.workspace, managedRoutine: { execute: managed.executeRoutine } }),
    inference: { homePath: f.f.home, lifetime: lifetime.signal } });
  const server = createScopeRuntimeBrokerServer({ socketPath, botImageFrames: true,
    broker: { handle: async () => { throw new Error("Unowned generic broker"); }, close() {} }, routeFrame: actions.handleFrame });
  await server.start(); f.setSourceAdapter(managed.adapter);
  return { ...f, socketPath, managed, actions, bindings, controls, workerEvents, workerLoopSettled: () => workerLoopSettled, broker: (binding: ManagedPiRuntimeBinding) => createBotBrokerClient({ socketPath, ...binding }), result: () => result, finish: resolveWorker,
    async close() { resolveWorker(); lifetime.abort(); await managed.close(); await server.close(); await f.close(); } };
}
