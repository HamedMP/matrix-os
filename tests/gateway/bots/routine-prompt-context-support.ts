import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { runBotTurn } from "../../../packages/bot-runtime/src/loop.js";
import { runCommandFromSpec } from "../../../packages/bot-runtime/src/worker.js";
import { createBotBindingsRepository } from "../../../packages/gateway/src/bots/repositories/bindings.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { BotRuntimeRegistry } from "../../../packages/gateway/src/bots/runtime-registry.js";
import type { createBotTaskOrchestrator } from "../../../packages/gateway/src/bots/task-orchestrator.js";
import type { createBotRoutineExecution } from "../../../packages/gateway/src/bots/routine-execution.js";
import type { fauxProvider } from "@earendil-works/pi-ai";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { BOT } from "./bot-state-support.js";
import { activated, admitFixture, data, proposal, subscription } from "./routine-authorization-support.js";

/** Keep the database, routine authority, adapter, spec, runtime and Pi request real. */
export async function createRoutinePromptHarness(options: {
  execution: ReturnType<typeof createBotRoutineExecution>; input: Awaited<ReturnType<typeof admitFixture>>;
  f: Awaited<ReturnType<typeof activated>>; provider: ReturnType<typeof fauxProvider>;
  beforeLoad?: (f: Awaited<ReturnType<typeof activated>>) => Promise<void>;
  instructions?: string; memory?: string[];
  cancelDuringCheck?: boolean; foreignBinding?: "ownerId" | "chatId" | "botId" | "taskId"; messages: AgentMessage[];
}) {
  const registry = new BotRuntimeRegistry(), controller = new AbortController();
  let orchestrator: ReturnType<typeof createBotTaskOrchestrator>;
  const dependencies = {
    bindings: createBotBindingsRepository(data.db),
    transact: createBotStateTransactions(new ChatRepository(data.db as never)),
    agents: { get: async () => ({ id: BOT, name: "Fixture Bot", description: "", instructions: options.instructions ?? "Follow the current request.", archived: false,
      selection: { instanceId: "matrix_chatgpt_plan", model: proposal.selection.model, options: [{ id: "accountId", value: subscription.accountId }, { id: "grantRevision", value: "3" }] },
      recipeRef: { recipeId: "writing-bot", version: "2026-09-27.1" }, revision: 1, createdAt: options.f.at, updatedAt: options.f.at }) },
    recipes: createBotRecipeCatalog(), registry,
    memory: { admitted: async () => options.memory ?? [] },
    resolveRoute: async () => ({ route: { api: "openai-responses", modelId: proposal.selection.model, input: ["text"], contextWindow: 128000, maxOutputTokens: 4096 }, accessSourceId: "matrix_chatgpt_plan", subscription }),
    routineExecution: { describeChatPhase: options.execution.describeChatPhase, assertOccurrencePhase: async (binding: Parameters<typeof options.execution.assertOccurrencePhase>[0]) => {
      if (options.cancelDuringCheck) { controller.abort(); await Promise.resolve(); }
      return options.execution.assertOccurrencePhase(binding);
    } },
    admission: {
      admit: async (request: Parameters<typeof registry.bind>[0]) => { registry.bind({ ...request, runtimeHandle: "runtime_" + "f".repeat(32), executionGeneration: "1", rootFingerprint: "a".repeat(64) }); return { runtimeHandle: "runtime_" + "f".repeat(32), executionGeneration: "1", rootFingerprint: "a".repeat(64) }; },
      release: async (handle: string) => { registry.release(handle); },
      startRenewal: () => ({ stop: async () => undefined }),
    },
    client: { runBot: async (request: { runtimeHandle: string; executionGeneration: string; command: { kind: string; runId: string } }) => {
      if (request.command.kind !== "bot.run") return { ok: true, reply: {} };
      if (options.beforeLoad) await options.beforeLoad(options.f);
      const binding = registry.lookupRun({ ...request, runId: request.command.runId })!;
      const spec = await orchestrator.runSource.loadRunSpec(options.foreignBinding ? { ...binding, [options.foreignBinding]: "foreign_fixture" } : binding);
      const command = runCommandFromSpec(request.command.runId, spec, []);
      const outcome = await runBotTurn({ command, bridgeOrigin: "http://127.0.0.1:1", signal: controller.signal,
        route: { provider: options.provider.provider, model: options.provider.getModel() },
        broker: { loadSession: async () => ({ revision: 1, needsRecompaction: false, messages: options.messages as never }),
          saveSession: async () => ({ revision: 2 }), tool: async () => { throw Error("Unexpected model tool"); },
          event: async () => undefined } });
      return { ok: true, reply: outcome };
    } },
    now: () => new Date(options.f.at),
  } as unknown as Parameters<typeof createBotTaskOrchestrator>[0];
  return { dependencies, signal: controller.signal, connect(value: typeof orchestrator) { orchestrator = value; } };
}
