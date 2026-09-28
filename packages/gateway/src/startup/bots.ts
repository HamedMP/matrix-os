/**
 * Starts recipe bot services on the owner database the chat repository owns
 * (spec 536, technical-design "Integration Wiring and Startup"):
 *
 * 1. Bot migrations; without them bots stay unavailable (routes answer 503)
 *    and the rest of the gateway keeps running.
 * 2. Creation and its reconciliation.
 * 3. When the scope runtime is available: the bot registry, the bot broker
 *    registered on the host, the task orchestrator, and the `matrix_bot`
 *    chat adapter. Tool checkpoints a previous process left `dispatched`
 *    become `effect_unknown` before any run starts; nothing is replayed.
 *
 * Closing stops reconciliation, unregisters the broker, and ends in-flight
 * model calls. The database stays with its owner.
 */
import type { AiProviderSnapshotV3 } from "@matrix-os/contracts";
import type { ChatAgentStore } from "../chat/agent-store.js";
import type { BotChatLookup } from "../chat/agent-context.js";
import type { ChatExecutionRootResolver } from "../chat/execution-root.js";
import type { CanonicalChatProviderAdapter } from "../chat/provider-adapter.js";
import type { ChatRepository } from "../chat/repository.js";
import type { FundedAdmissionQueue } from "../funded-ai/admission-queue.js";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import type { ScopeRuntimeHost } from "../scope-runtime-host/index.js";
import { createPrivateBotAdmission } from "../bots/admission.js";
import { createBotBrokerActions, registerBotBroker } from "../bots/broker-actions.js";
import { createMatrixBotChatProviderAdapter, type BotChatState } from "../bots/chat-adapter.js";
import { bootstrapBotDatabase } from "../bots/database.js";
import { createBotInstantiation, ensureBotWorkspace, ownerBotExecutor, type BotInstantiation } from "../bots/instantiation.js";
import { createBotRecipeCatalog } from "../bots/recipe-catalog.js";
import { createBotOperationReconciler } from "../bots/reconciliation.js";
import { createBotBindingsRepository } from "../bots/repositories/bindings.js";
import { createBotCheckpointsRepository } from "../bots/repositories/checkpoints.js";
import { createBotOperationsRepository } from "../bots/repositories/operations.js";
import { createBotSessionsRepository } from "../bots/repositories/sessions.js";
import { createBotTasksRepository } from "../bots/repositories/tasks.js";
import { resolveBotRoute } from "../bots/route-resolver.js";
import { BotRuntimeRegistry } from "../bots/runtime-registry.js";
import { createBotTaskOrchestrator } from "../bots/task-orchestrator.js";
import { createBotToolDispatcher } from "../bots/tool-dispatcher.js";

/** Bounded passes; the table only holds this owner's checkpoints. */
const MAX_CHECKPOINT_RECONCILE_PASSES = 50;

export interface BotServices {
  instantiation: BotInstantiation;
  botChats: BotChatLookup;
  /** Present only when the scope runtime can run bot workloads. */
  adapter?: CanonicalChatProviderAdapter<BotChatState>;
  close(): Promise<void>;
}

export async function startBots(options: {
  homePath: string;
  repository: Pick<ChatRepository, "kysely" | "withTransaction">;
  agents: ChatAgentStore;
  executionRoots: Pick<ChatExecutionRootResolver, "resolve">;
  providers: { getSnapshot(): Promise<AiProviderSnapshotV3> };
  host?: ScopeRuntimeHost;
  fundedCredentialProvider?: MatrixFundedCredentialProvider;
  fundedAdmission?: FundedAdmissionQueue;
  now?: () => Date;
}): Promise<BotServices | undefined> {
  const now = () => options.now?.() ?? new Date();
  const db = ownerBotExecutor(options.repository.kysely);
  try {
    await bootstrapBotDatabase(db);
  } catch (error: unknown) {
    console.warn("[bots] bot state unavailable:", error instanceof Error ? error.name : "UnknownError");
    return undefined;
  }
  const recipes = createBotRecipeCatalog();
  const bindings = createBotBindingsRepository(db);
  const instantiation = createBotInstantiation({
    db,
    chats: options.repository,
    agents: options.agents,
    recipes,
    ensureWorkspace: (botId) => ensureBotWorkspace(options.homePath, botId),
  });
  const reconciler = createBotOperationReconciler({ operations: createBotOperationsRepository(db), instantiation });
  await reconciler.start();
  const botChats: BotChatLookup = {
    async directBot(owner, chatId) {
      if (owner.type !== "personal") return null;
      const bound = await bindings.forChat({ ownerId: owner.ownerId, chatId });
      return bound.find((binding) => binding.kind === "direct")?.botId ?? null;
    },
  };
  const host = options.host;
  if (!host?.available) {
    return { instantiation, botChats, close: () => reconciler.stop() };
  }

  const checkpoints = createBotCheckpointsRepository(db);
  const startedAt = now().toISOString();
  for (let pass = 0; pass < MAX_CHECKPOINT_RECONCILE_PASSES; pass += 1) {
    if (await checkpoints.reconcileDispatched({ olderThan: startedAt, now: startedAt }) === 0) break;
  }

  const lifetime = new AbortController();
  const registry = new BotRuntimeRegistry();
  const admission = createPrivateBotAdmission({ db, host, roots: options.executionRoots, registry });
  let forgetRun: (runId: string) => void = () => undefined;
  const orchestrator = createBotTaskOrchestrator({
    bindings,
    tasks: createBotTasksRepository(db),
    agents: options.agents,
    recipes,
    resolveRoute: async () => resolveBotRoute(await options.providers.getSnapshot()),
    admission,
    registry,
    client: host.client,
    onRunFinished: (runId) => forgetRun(runId),
  });
  const actions = createBotBrokerActions({
    db,
    registry,
    sessions: createBotSessionsRepository(db),
    checkpoints,
    runs: orchestrator.runSource,
    events: orchestrator.eventSink,
    tools: createBotToolDispatcher({ homePath: options.homePath }),
    inference: {
      homePath: options.homePath,
      lifetime: lifetime.signal,
      ...(options.fundedCredentialProvider ? { fundedCredentialProvider: options.fundedCredentialProvider } : {}),
      ...(options.fundedAdmission ? { fundedAdmission: options.fundedAdmission } : {}),
    },
  });
  forgetRun = (runId) => actions.forgetRun(runId);
  const unregister = registerBotBroker(host, actions);
  const adapter = createMatrixBotChatProviderAdapter({
    orchestrator,
    stopRuntime: (runtimeHandle) => admission.release(runtimeHandle),
  });
  return {
    instantiation,
    botChats,
    adapter,
    async close() {
      await reconciler.stop();
      unregister();
      lifetime.abort();
      registry.shutdown();
    },
  };
}
