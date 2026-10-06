import { createManagedPiOwnerTools } from "../chat/managed-pi-owner-tools.js";
import { createManagedPiAdmission } from "../chat/managed-pi-admission.js";
import { createManagedPiRuntime } from "../chat/managed-pi-runtime.js";
import { createManagedPiSessionsRepository } from "../chat/managed-pi-sessions.js";
import { createManagedPiCheckpointsRepository } from "../chat/managed-pi-checkpoints.js";
import { resolveManagedPiRoute } from "../bots/route-resolver.js";
import { BotInstantiationError } from "../bots/instantiation.js";
import { isManagedPiBinding } from "../bots/runtime-registry.js";
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
import { createBotRecipeCatalog, type BotRecipeCatalog } from "../bots/recipe-catalog.js";
import { createBotOperationReconciler } from "../bots/reconciliation.js";
import { createBotBindingsRepository } from "../bots/repositories/bindings.js";
import { createBotCheckpointsRepository } from "../bots/repositories/checkpoints.js";
import { createBotOperationsRepository } from "../bots/repositories/operations.js";
import { createBotSessionsRepository } from "../bots/repositories/sessions.js";
import { createBotTasksRepository } from "../bots/repositories/tasks.js";
import { createBotAccessHandlers } from "../bots/access-handlers.js";
import { createBotAuthority, type BotAuthority } from "../bots/authority.js";
import { createBotConnections, type BotConnections } from "../bots/connections.js";
import type { BotContinuationAdmitter } from "../bots/continuations.js";
import { createBotStateTransactions } from "../bots/events.js";
import { createBotGrantService, type BotGrantService } from "../bots/grants-service.js";
import { createBotIntegrationClient, type BotIntegrationTransport } from "../bots/integration-client.js";
import { createBotIntegrationTools } from "../bots/integration-tools.js";
import { createBotInteractionService, type BotInteractionService } from "../bots/interactions.js";
import { createBotMemoryService, type BotMemoryService } from "../bots/memory-service.js";
import { createBotModelRouteResolver } from "../bots/codex-route.js";
import { createCodexOwnerIdentityResolver } from "../collaboration/codex-owner-identity.js";
import { BotRuntimeRegistry } from "../bots/runtime-registry.js";
import { createBotTaskOrchestrator } from "../bots/task-orchestrator.js";
import { createBotToolDispatcher, sweepBotWorkspaceSaves } from "../bots/tool-dispatcher.js";

/** Passes before the first run is admitted; any rest is finished in the background. */
const MAX_CHECKPOINT_RECONCILE_PASSES = 50;
const CHECKPOINT_RECONCILE_INTERVAL_MS = 5_000;
const SAVE_SWEEP_INTERVAL_MS = 10 * 60_000;
const INTERACTION_SWEEP_MS = 60_000;
const CONNECTION_RECONCILE_MS = 30_000;

/** One bounded pass; each owner and each admission fails independently. */
export async function runConnectionReconciliationPass(
  connections: Pick<BotConnections, "ownersWithPending" | "reconcile" | "pendingContinuations" | "ackContinuation" | "deferContinuation" | "deferOwner">,
  admit: BotContinuationAdmitter,
): Promise<void> {
  for (const ownerId of await connections.ownersWithPending()) {
    try {
      await connections.reconcile(ownerId);
    } catch (error: unknown) {
      console.warn("[bots] connection reconciliation failed:", error instanceof Error ? error.name : "UnknownError");
      try {
        await connections.deferOwner(ownerId);
      } catch (deferError: unknown) {
        console.warn("[bots] connection owner retry unavailable:", deferError instanceof Error ? deferError.name : "UnknownError");
      }
    }
    try {
      for (const continuation of await connections.pendingContinuations(ownerId)) {
        try {
          await admit({ userId: ownerId, source: "configured-container" }, continuation);
          await connections.ackContinuation(ownerId, continuation.clientRequestId);
        } catch (error: unknown) {
          console.warn("[bots] connection continuation failed:", error instanceof Error ? error.name : "UnknownError");
          try {
            await connections.deferContinuation(ownerId, continuation.clientRequestId);
          } catch (deferError: unknown) {
            console.warn("[bots] connection continuation retry unavailable:", deferError instanceof Error ? deferError.name : "UnknownError");
          }
        }
      }
    } catch (error: unknown) {
      console.warn("[bots] connection continuation lookup failed:", error instanceof Error ? error.name : "UnknownError");
    }
  }
}

export interface BotServices {
  recipes: BotRecipeCatalog;
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
  tasks(ownerId: string, chatId: string): Promise<import("@matrix-os/contracts").BotTaskSummary[]>;
  /** Present only when the scope runtime can run bot workloads. */
  adapter?: CanonicalChatProviderAdapter<BotChatState>;
  managedAdapter?: CanonicalChatProviderAdapter;
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
  managedMcp?: { client: import("../chat/managed-pi-mcp-client.js").ManagedPiMcpClient; approvals: import("../chat/custom-mcp-approval-client.js").CustomMcpApprovalClient };
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
    validateSelection: async (_ownerId, selection) => {
      if (!options.host?.available) throw new BotInstantiationError("unavailable");
      try { resolveManagedPiRoute(await options.providers.getSnapshot(), selection); }
      catch (error: unknown) { console.warn("[bots] selected managed model unavailable", error instanceof Error ? error.name : "UnknownError"); throw new BotInstantiationError("invalid_request"); }
    },
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
      connecting ??= runConnectionReconciliationPass(connections, admit).catch((error: unknown) => {
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
    async directChat(owner, agentId) {
      if (owner.type !== "personal") return null;
      const agent = await options.agents.get(owner, agentId);
      if (!agent?.recipeRef || agent.archived) return null;
      return await bindings.directChatId({ ownerId: owner.ownerId, botId: agentId }) ?? null;
    },
    async directBot(owner, chatId) {
      if (owner.type !== "personal") return null;
      const bound = await bindings.forChat({ ownerId: owner.ownerId, chatId });
      return bound.find((binding) => binding.kind === "direct")?.botId ?? null;
    },
  };
  const tasks: BotServices["tasks"] = async (ownerId, chatId) => {
    const botId = await botChats.directBot({ type: "personal", ownerId }, chatId);
    if (!botId) return [];
    return transact(ownerId, async (tx) => (await createBotTasksRepository(tx.db).listOpen({ ownerId, botId, chatId }, tx.db))
      .map((task) => ({ taskId: task.taskId, chatId: task.chatId, agentId: task.botId,
        ...(task.runId ? { runId: task.runId } : {}),
        status: task.status, ...(task.blockedReason ? { blockedReason: task.blockedReason } : {}),
        revision: task.revision, updatedAt: task.updatedAt })));
  };
  const host = options.host;
  if (!host?.available) {
    return {
      recipes, instantiation, interactions, memory, grants, authority, botChats, tasks, startConnectionReconciler,
      async close() {
        await stopConnections();
        await stopSweep();
        await reconciler.stop();
      },
    };
  }

  const checkpoints = createBotCheckpointsRepository(db);
  const managedCheckpoints = createManagedPiCheckpointsRepository(db);
  const startedAt = now().toISOString();
  // Both namespaces can exceed one bounded batch after a crash. Keep draining
  // only pre-start rows, without replaying any tool effect.
  const reconcileCheckpoints = async (at: string) => {
    const botChanged = await checkpoints.reconcileDispatched({ olderThan: startedAt, now: at });
    const managedChanged = await managedCheckpoints.reconcileDispatched({ olderThan: startedAt, now: at });
    return botChanged + managedChanged;
  };
  const passes = Math.max(1, Math.min(Math.trunc(options.checkpointReconcile?.passes ?? MAX_CHECKPOINT_RECONCILE_PASSES), MAX_CHECKPOINT_RECONCILE_PASSES));
  const interval = Math.max(10, Math.min(Math.trunc(options.checkpointReconcile?.intervalMs ?? CHECKPOINT_RECONCILE_INTERVAL_MS), CHECKPOINT_RECONCILE_INTERVAL_MS));
  let leftover = true;
  for (let pass = 0; pass < passes && leftover; pass += 1) {
    leftover = await reconcileCheckpoints(startedAt) > 0;
  }
  // Checkpoints from before this start are all closed eventually: one bounded pass per tick until none remain.
  let reconciling: Promise<unknown> | undefined;
  const checkpointTimer = leftover ? setInterval(() => {
    reconciling ??= reconcileCheckpoints(now().toISOString())
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
  const resolveCodexIdentity = createCodexOwnerIdentityResolver({ homePath: options.homePath });
  const registry = new BotRuntimeRegistry();
  const admission = createPrivateBotAdmission({ db, host, roots: options.executionRoots, registry });
  const managedCapabilities: import("@matrix-os/contracts").BotToolCapability[] = [
    ...(integrationClient ? ["integration.inventory", "integration.describe", "integration.call"] as const : []),
    ...(options.managedMcp ? ["mcp.inventory", "mcp.describe", "mcp.call"] as const : []),
  ];
  const managedAdmission = createManagedPiAdmission({ db, homePath: options.homePath, host, registry, roots: options.executionRoots, toolCapabilities: managedCapabilities });
  const ownerTools = createManagedPiOwnerTools({ authority: managedAdmission.toolAuthority, signalFor: binding => registry.inferenceSignal(binding),
    ...(integrationClient ? { integrations: integrationClient } : {}),
    ...(options.managedMcp ? { mcp: options.managedMcp.client, approvals: options.managedMcp.approvals } : {}) });
  let forgetRun: (runId: string) => void = () => undefined;
  const orchestrator = createBotTaskOrchestrator({
    bindings,
    transact,
    interactions,
    memory,
    agents: options.agents,
    recipes,
    resolveRoute: createBotModelRouteResolver({
      providers: options.providers,
      resolveCodexIdentity,
      lifetime: lifetime.signal,
      ...(process.env.MATRIX_BOT_CODEX_MODEL !== undefined ? { codexModel: process.env.MATRIX_BOT_CODEX_MODEL } : {}),
    }),
    admission,
    registry,
    client: host.client,
    onRunFinished: (runId) => forgetRun(runId),
  });
  const managed = createManagedPiRuntime({ ownerTools, admission: managedAdmission, host, providers: options.providers, lifetime: lifetime.signal,
    forgetRun: (runId) => forgetRun(runId), cancelInference: (binding) => registry.cancelInference(binding) });
  const actions = createBotBrokerActions({
    db,
    registry,
    sessions: createBotSessionsRepository(db),
    managedSessions: createManagedPiSessionsRepository(db),
    managedCheckpoints,
    checkpoints,
    runs: {
      loadRunSpec: (binding) => isManagedPiBinding(binding) ? managed.runs.loadRunSpec(binding) : orchestrator.runSource.loadRunSpec(binding),
      readImageChunk: (binding, request) => isManagedPiBinding(binding) ? managed.runs.readImageChunk(binding, request) : orchestrator.runSource.readImageChunk(binding, request),
    },
    events: { publish: (binding, event) => isManagedPiBinding(binding) ? managed.events.publish(binding, event) : orchestrator.eventSink.publish(binding, event) },
    tools: createBotToolDispatcher({
      homePath: options.homePath, managedTools: ownerTools, managedWorkspace: managedAdmission.workspace, interactions, memory, ...(integrationTools ? { integrations: integrationTools } : {}),
    }),
    inference: {
      homePath: options.homePath,
      onFundedFailure: (binding, reason) => managed.recordFundedFailure(binding, reason),
      revalidateBinding: async (binding) => {
        if (!isManagedPiBinding(binding)) return true;
        try { await managedAdmission.workspace(binding); return true; }
        catch (error: unknown) { console.warn("[managed-pi] authority revalidation failed", error instanceof Error ? error.name : "UnknownError"); return false; }
      },
      lifetime: lifetime.signal,
      resolveCodexIdentity,
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
    recipes,
    instantiation,
    interactions,
    memory,
    grants,
    authority,
    startConnectionReconciler,
    botChats,
    tasks,
    adapter,
    managedAdapter: managed.adapter,
    async close() {
      if (checkpointTimer) clearInterval(checkpointTimer);
      clearInterval(saveSweepTimer);
      await reconciling;
      await sweepingSaves;
      await stopConnections();
      await stopSweep();
      await reconciler.stop();
      lifetime.abort();
      await managed.close();
      unregister();
      registry.shutdown();
    },
  };
}
