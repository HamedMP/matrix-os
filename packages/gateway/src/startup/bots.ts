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
import { createBotAccessHandlers } from "../bots/access-handlers.js";
import { createBotAuthority, type BotAuthority } from "../bots/authority.js";
import { createBotConnections } from "../bots/connections.js";
import type { BotContinuationAdmitter } from "../bots/continuations.js";
import { createBotStateTransactions } from "../bots/events.js";
import { createBotGrantService, type BotGrantService } from "../bots/grants-service.js";
import { createBotIntegrationClient, type BotIntegrationTransport } from "../bots/integration-client.js";
import { createBotIntegrationTools } from "../bots/integration-tools.js";
import { createBotInteractionService, type BotInteractionService } from "../bots/interactions.js";
import { createBotMemoryService, type BotMemoryService } from "../bots/memory-service.js";
import { resolveBotRoute } from "../bots/route-resolver.js";
import { BotRuntimeRegistry } from "../bots/runtime-registry.js";
import { createBotTaskOrchestrator } from "../bots/task-orchestrator.js";
import { createBotToolDispatcher, sweepBotWorkspaceSaves } from "../bots/tool-dispatcher.js";

/** Passes before the first run is admitted; any rest is finished in the background. */
const MAX_CHECKPOINT_RECONCILE_PASSES = 50;
const CHECKPOINT_RECONCILE_INTERVAL_MS = 5_000;
const SAVE_SWEEP_INTERVAL_MS = 10 * 60_000;
const INTERACTION_SWEEP_MS = 60_000;
const CONNECTION_RECONCILE_MS = 30_000;

export interface BotServices {
  instantiation: BotInstantiation;
  authority: BotAuthority;
  /**
   * Starts completing started connection requests. Called once the chat
   * orchestrator exists, with the admitter that continues each task.
   */
  startConnectionReconciler(admit: BotContinuationAdmitter): void;
  interactions: BotInteractionService;
  memory: BotMemoryService;
  grants: BotGrantService;
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
  /** How the gateway reaches the owner's integrations; without it bots have no integration tools. */
  integrations?: BotIntegrationTransport;
  fundedCredentialProvider?: MatrixFundedCredentialProvider;
  fundedAdmission?: FundedAdmissionQueue;
  now?: () => Date;
  /** Test hook for startup checkpoint passes; bounded to the defaults. */
  checkpointReconcile?: { passes?: number; intervalMs?: number };
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
  const transact = createBotStateTransactions(options.repository);
  const integrationClient = options.integrations ? createBotIntegrationClient(options.integrations) : undefined;
  const integrationTools = integrationClient
    ? createBotIntegrationTools({ client: integrationClient, transact, recipes, agents: options.agents })
    : undefined;
  const connections = integrationClient && integrationTools
    ? createBotConnections({ client: integrationClient, transact, tools: integrationTools })
    : undefined;
  const interactions = createBotInteractionService({
    transact,
    ...(integrationTools ? {
      handlers: {
        ...createBotAccessHandlers({ tools: integrationTools }),
        ...(connections ? { startConnect: connections.startConnect } : {}),
      },
    } : {}),
  });
  const authority = createBotAuthority({ transact, agents: options.agents, recipes, ...(integrationClient ? { client: integrationClient } : {}) });
  // Started connection requests are completed from the inventory; passes never overlap and stop on close.
  let connectionTimer: ReturnType<typeof setInterval> | undefined;
  let connecting: Promise<unknown> | undefined;
  const startConnectionReconciler = (admit: BotContinuationAdmitter) => {
    if (!connections || connectionTimer) return;
    connectionTimer = setInterval(() => {
      connecting ??= (async () => {
        for (const ownerId of await connections.ownersWithPending()) {
          for (const continuation of await connections.reconcile(ownerId)) {
            try {
              await admit({ userId: ownerId, source: "configured-container" }, continuation);
            } catch (error: unknown) {
              console.warn("[bots] connection continuation failed:", error instanceof Error ? error.name : "UnknownError");
            }
          }
        }
      })().catch((error: unknown) => {
        console.warn("[bots] connection reconciliation unavailable:", error instanceof Error ? error.name : "UnknownError");
      }).finally(() => { connecting = undefined; });
    }, CONNECTION_RECONCILE_MS);
    connectionTimer.unref();
  };
  const stopConnections = async () => {
    if (connectionTimer) clearInterval(connectionTimer);
    connectionTimer = undefined;
    await connecting;
  };
  const memory = createBotMemoryService({ transact });
  const grants = createBotGrantService({ transact });
  // Overdue questions are expired and announced; passes never overlap and stop on close.
  let sweeping: Promise<unknown> | undefined;
  const sweep = setInterval(() => {
    sweeping ??= interactions.expireAllDue().catch((error: unknown) => {
      console.warn("[bots] question expiry failed:", error instanceof Error ? error.name : "UnknownError");
    }).finally(() => { sweeping = undefined; });
  }, INTERACTION_SWEEP_MS);
  sweep.unref();
  const stopSweep = async () => {
    clearInterval(sweep);
    await sweeping;
  };
  const botChats: BotChatLookup = {
    async directBot(owner, chatId) {
      if (owner.type !== "personal") return null;
      const bound = await bindings.forChat({ ownerId: owner.ownerId, chatId });
      return bound.find((binding) => binding.kind === "direct")?.botId ?? null;
    },
  };
  const host = options.host;
  if (!host?.available) {
    return {
      instantiation, interactions, memory, grants, authority, botChats, startConnectionReconciler,
      async close() {
        await stopConnections();
        await stopSweep();
        await reconciler.stop();
      },
    };
  }

  const checkpoints = createBotCheckpointsRepository(db);
  const startedAt = now().toISOString();
  const passes = Math.max(1, Math.min(Math.trunc(options.checkpointReconcile?.passes ?? MAX_CHECKPOINT_RECONCILE_PASSES), MAX_CHECKPOINT_RECONCILE_PASSES));
  const interval = Math.max(10, Math.min(Math.trunc(options.checkpointReconcile?.intervalMs ?? CHECKPOINT_RECONCILE_INTERVAL_MS), CHECKPOINT_RECONCILE_INTERVAL_MS));
  let leftover = true;
  for (let pass = 0; pass < passes && leftover; pass += 1) {
    leftover = await checkpoints.reconcileDispatched({ olderThan: startedAt, now: startedAt }) > 0;
  }
  // Checkpoints from before this start are all closed eventually: one bounded pass per tick until none remain.
  let reconciling: Promise<unknown> | undefined;
  const checkpointTimer = leftover ? setInterval(() => {
    reconciling ??= checkpoints.reconcileDispatched({ olderThan: startedAt, now: now().toISOString() })
      .then((changed) => { if (changed === 0 && checkpointTimer) clearInterval(checkpointTimer); })
      .catch((error: unknown) => {
        console.warn("[bots] checkpoint reconciliation failed:", error instanceof Error ? error.name : "UnknownError");
      })
      .finally(() => { reconciling = undefined; });
  }, interval) : undefined;
  checkpointTimer?.unref();
  // Staged saves a stopped process left behind are removed at start and then periodically.
  let sweepingSaves: Promise<unknown> | undefined;
  const sweepSaves = () => {
    sweepingSaves ??= sweepBotWorkspaceSaves(options.homePath).catch((error: unknown) => {
      console.warn("[bots] staged save cleanup failed:", error instanceof Error ? error.name : "UnknownError");
    }).finally(() => { sweepingSaves = undefined; });
  };
  sweepSaves();
  const saveSweepTimer = setInterval(sweepSaves, SAVE_SWEEP_INTERVAL_MS);
  saveSweepTimer.unref();

  const lifetime = new AbortController();
  const registry = new BotRuntimeRegistry();
  const admission = createPrivateBotAdmission({ db, host, roots: options.executionRoots, registry });
  let forgetRun: (runId: string) => void = () => undefined;
  const orchestrator = createBotTaskOrchestrator({
    bindings,
    transact,
    interactions,
    memory,
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
    tools: createBotToolDispatcher({
      homePath: options.homePath, interactions, memory, ...(integrationTools ? { integrations: integrationTools } : {}),
    }),
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
    interactions,
    memory,
    grants,
    authority,
    startConnectionReconciler,
    botChats,
    adapter,
    async close() {
      if (checkpointTimer) clearInterval(checkpointTimer);
      clearInterval(saveSweepTimer);
      await reconciling;
      await sweepingSaves;
      await stopConnections();
      await stopSweep();
      await reconciler.stop();
      unregister();
      lifetime.abort();
      registry.shutdown();
    },
  };
}
