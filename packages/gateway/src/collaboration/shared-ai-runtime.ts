import {
  SCOPE_RUNTIME_HARNESS_VERSION,
  SCOPE_RUNTIME_PROFILE_DIGEST,
  SCOPE_RUNTIME_PROFILE_ID,
  SCOPE_RUNTIME_PROFILE_VERSION,
} from "@matrix-os/scope-runtime/profile";
import type { Kysely } from "kysely";
import {
  SharedChatRunPreparationError,
  type CanonicalChatOrchestrator,
} from "../chat/orchestrator.js";
import { CollaborationChatCommands } from "../chat/collaboration-commands.js";
import type { ChatRepository } from "../chat/repository.js";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import {
  resolveKernelCredentialSources,
  type KernelCredentialAccessSourceId,
} from "../kernel-credentials.js";
import {
  CollaborationAuthorizationError,
  type CollaborationAuthority,
} from "./authority.js";
import {
  CollaborationChatExecutionAdapter,
  parseCollaborationAiEligibility,
  type CollaborationAiExecutionEligibility,
} from "./chat-execution-adapter.js";
import type { CollaborationChatScopeService } from "./chat-scope.js";
import type { OwnerCollaborationDatabase } from "./database.js";
import type { CollaborationEventRegistry } from "./events.js";
import {
  CollaborationPolicyClient,
  CollaborationPolicyClientError,
} from "./policy-client.js";
import { createScopeRuntimeBroker, createScopeRuntimeBrokerServer } from "./scope-runtime-broker.js";
import { createScopeRuntimeChatProviderAdapter } from "./scope-runtime-chat-adapter.js";
import {
  createScopeRuntimeClient,
  type ScopeRuntimeProfileCatalog,
} from "./scope-runtime-client.js";
import { SharedAiRuntimeRegistry } from "./shared-ai-runtime-registry.js";
import type { CollaborationActorProofVerifier } from "./actor-proof.js";
const SUPERVISOR_SOCKET = "/run/matrix-scope-runtime/supervisor.sock";
const BROKER_SOCKET = "/run/matrix-scope-runtime/broker.sock";
const QUEUE_WAKE_INTERVAL_MS = 10_000;
const QUEUE_WAKE_LIMIT = 64;
const PROFILE_CATALOG: ScopeRuntimeProfileCatalog = {
  [SCOPE_RUNTIME_PROFILE_ID]: {
    profileVersion: SCOPE_RUNTIME_PROFILE_VERSION,
    profileDigest: SCOPE_RUNTIME_PROFILE_DIGEST,
    identity: { mode: "dynamic", uidMin: 61_184, uidMax: 65_519 },
    supportedAdapters: {
      "claude-code": {
        harnessVersions: [SCOPE_RUNTIME_HARNESS_VERSION],
        workloads: ["chat_ai"],
      },
    },
  },
};
const ELIGIBILITY: CollaborationAiExecutionEligibility = {
  profileId: SCOPE_RUNTIME_PROFILE_ID,
  profileVersion: SCOPE_RUNTIME_PROFILE_VERSION,
  profileDigest: SCOPE_RUNTIME_PROFILE_DIGEST,
  adapterId: "claude-code",
  harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION,
};
export async function createSharedAiRuntime(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  repository: ChatRepository;
  chatScope: CollaborationChatScopeService;
  authority: CollaborationAuthority;
  verifier: CollaborationActorProofVerifier;
  eventRegistry: CollaborationEventRegistry;
  orchestrator: CanonicalChatOrchestrator;
  platformBaseUrl: string;
  runtimeId: string;
  serviceToken: string;
  homePath: string;
  fundedCredentialProvider?: MatrixFundedCredentialProvider;
  resolveParticipant(actorId: string): Promise<{ actorId: string; displayName: string }>;
  supervisorSocket?: string;
  brokerSocket?: string;
  fetchImpl?: typeof fetch;
  resolveAccessSource?: () => Promise<KernelCredentialAccessSourceId>;
}) {
  const client = createScopeRuntimeClient({
    socketPath: options.supervisorSocket ?? SUPERVISOR_SOCKET,
    profileCatalog: PROFILE_CATALOG,
  });
  const capability = await client.refreshCapability();
  if (!capability.available) {
    await options.chatScope.reconcileExecutionEligibility({ executionGeneration: null, eligibility: null });
    return {
      available: false as const,
      async shutdown(): Promise<void> { await client.close(); },
    };
  }
  const executionGeneration = Number(capability.executionGeneration);
  if (!Number.isSafeInteger(executionGeneration) || executionGeneration < 1) {
    await options.chatScope.reconcileExecutionEligibility({ executionGeneration: null, eligibility: null });
    await client.close();
    return { available: false as const, async shutdown(): Promise<void> {} };
  }
  await options.chatScope.reconcileExecutionEligibility({ executionGeneration, eligibility: ELIGIBILITY });
  const policy = new CollaborationPolicyClient({
    platformBaseUrl: options.platformBaseUrl,
    runtimeId: options.runtimeId,
    serviceToken: options.serviceToken,
    verifier: options.verifier,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const registry = new SharedAiRuntimeRegistry();
  const resolveAccessSource = options.resolveAccessSource
    ?? (async () => (await resolveKernelCredentialSources(
      options.homePath,
      process.env,
      options.fundedCredentialProvider,
    )).selectedAccessSourceId);
  const commands = new CollaborationChatCommands({
    db: options.db,
    submitApproval: async () => {
      throw new Error("The fixed shared Chat adapter does not expose approval callbacks");
    },
    submitCancellation: createSharedAiCancellationDispatcher({
      policy,
      authority: options.authority,
      orchestrator: options.orchestrator,
    }),
    reconcileApproval: createSharedAiApprovalReconciler({
      resolveOwnerId: (scopeId, chatId) => ownerIdFor(options.db, scopeId, chatId),
      readRunStatus: async (chatId, runId) => {
        const run = await options.db.selectFrom("chat_runs").select("status")
          .where("id", "=", runId).where("chat_id", "=", chatId).executeTakeFirst();
        return run?.status ?? null;
      },
      orchestrator: options.orchestrator,
    }),
  });
  const dispatch = async (scopeId: string, chatId: string): Promise<void> => {
    const preflightPolicy = await policy.getM2();
    if (preflightPolicy.mode === "off" || preflightPolicy.mode === "read_only") return;
    await options.orchestrator.dispatchNextSharedQueued(
      { type: "personal", ownerId: await ownerIdFor(options.db, scopeId, chatId) },
      chatId,
      scopeId,
      async (execution) => {
        try {
          const currentPolicy = await policy.getM2();
          const context = await options.authority.authorize({
            scopeId,
            actorId: execution.requestingActorId,
            action: "request_ai",
            executionPolicy: currentPolicy,
          });
          if (context.resourceId !== chatId || context.ownerId.length === 0
            || execution.executionGeneration !== executionGeneration
            || !eligibilityMatches(execution.executionEligibility)) {
            throw new SharedChatRunPreparationError("unavailable");
          }
          const accessSourceId = await resolveAccessSource();
          return createScopeRuntimeChatProviderAdapter({
            client: scopedClient({
              client,
              registry,
              scopeId,
              chatId,
              ownerId: context.ownerId,
              actorId: context.actorId,
              accessSourceId,
            }),
            scopeId,
            executionGeneration: capability.executionGeneration,
            adapterId: "claude-code",
            harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION,
          });
        } catch (error: unknown) {
          if (error instanceof SharedChatRunPreparationError) throw error;
          if (error instanceof CollaborationAuthorizationError) {
            throw new SharedChatRunPreparationError(
              error.code === "not_found" || error.code === "forbidden" ? "unauthorized" : "unavailable",
            );
          }
          if (!(error instanceof CollaborationPolicyClientError)) {
            console.warn("[collaboration] shared AI preparation unavailable",
              error instanceof Error ? error.name : "UnknownError");
          }
          throw new SharedChatRunPreparationError("unavailable");
        }
      },
    );
  };

  const chatExecutionAdapter = new CollaborationChatExecutionAdapter({
    repository: options.repository,
    commands,
    resolveParticipant: options.resolveParticipant,
    resolveResourceRevision: async (scopeId, chatId) => {
      const row = await options.db.selectFrom("chats")
        .innerJoin("collaboration_scopes", "collaboration_scopes.resource_id", "chats.id")
        .select("chats.revision")
        .where("collaboration_scopes.id", "=", scopeId)
        .where("collaboration_scopes.kind", "=", "chat")
        .where("collaboration_scopes.lifecycle", "=", "shared")
        .where("chats.id", "=", chatId)
        .where("chats.lifecycle", "=", "active")
        .whereRef("chats.owner_id", "=", "collaboration_scopes.owner_id")
        .whereRef("chats.owner_type", "=", "collaboration_scopes.owner_type")
        .executeTakeFirst();
      return row ? Number(row.revision) : null;
    },
    resolveEligibility: async (scopeId) => {
      const scope = await options.db.selectFrom("collaboration_scopes")
        .select(["execution_generation", "execution_eligibility"])
        .where("id", "=", scopeId).where("kind", "=", "chat")
        .where("lifecycle", "=", "shared").executeTakeFirst();
      if (!scope || Number(scope.execution_generation) !== executionGeneration
        || !eligibilityMatches(scope.execution_eligibility)) {
        throw new Error("Shared AI execution eligibility changed");
      }
      return scope.execution_eligibility;
    },
    requestDispatch: dispatch,
    onCommitted: (scopeId) => options.eventRegistry.broadcastScope(scopeId),
  });

  const broker = createScopeRuntimeBroker({
    homePath: options.homePath,
    fundedCredentialProvider: options.fundedCredentialProvider,
    authorize: async (request) => {
      const binding = registry.lookup(request);
      if (!binding) return { allowed: false };
      try {
        const currentPolicy = await policy.getM2();
        const context = await options.authority.authorize({
          scopeId: binding.scopeId,
          actorId: binding.actorId,
          action: "request_ai",
          executionPolicy: currentPolicy,
        });
        if (context.resourceId !== binding.chatId || context.ownerId !== binding.ownerId) {
          return { allowed: false };
        }
        return registry.authorize(request);
      } catch (error: unknown) {
        console.warn("[collaboration] shared AI broker reauthorization failed",
          error instanceof Error ? error.name : "UnknownError");
        return { allowed: false };
      }
    },
  });
  const brokerServer = createScopeRuntimeBrokerServer({
    socketPath: options.brokerSocket ?? BROKER_SOCKET,
    broker,
  });
  try {
    await brokerServer.start();
  } catch (error: unknown) {
    console.warn("[collaboration] shared AI broker unavailable",
      error instanceof Error ? error.name : "UnknownError");
    registry.shutdown();
    await brokerServer.close();
    await client.close();
    await options.chatScope.reconcileExecutionEligibility({ executionGeneration: null, eligibility: null });
    return { available: false as const, async shutdown(): Promise<void> {} };
  }
  let stopped = false;
  let wakeInFlight: Promise<void> | undefined;
  const runQueueWake = async (): Promise<void> => {
    try {
      await commands.reconcilePendingApprovals();
      const currentPolicy = await policy.getM2();
      if (currentPolicy.mode === "off" || currentPolicy.mode === "read_only") return;
      const rows = await options.db.selectFrom("chat_queued_turns as queued")
        .innerJoin("collaboration_scopes as scope", "scope.id", "queued.collaboration_scope_id")
        .select(["scope.id as scope_id", "scope.resource_id as chat_id", "queued.created_at"])
        .where("queued.status", "=", "queued")
        .where("scope.kind", "=", "chat")
        .where("scope.lifecycle", "=", "shared")
        .where("scope.execution_generation", "=", executionGeneration)
        .orderBy("queued.created_at")
        .limit(QUEUE_WAKE_LIMIT)
        .execute();
      const scopes: Record<string, { scopeId: string; chatId: string }> = Object.create(null) as Record<
        string,
        { scopeId: string; chatId: string }
      >;
      for (const row of rows) scopes[row.scope_id] ??= { scopeId: row.scope_id, chatId: row.chat_id };
      await Promise.allSettled(Object.values(scopes).map((row) => dispatch(row.scopeId, row.chatId)));
    } catch (error: unknown) {
      console.warn("[collaboration] shared AI queue recovery deferred",
        error instanceof Error ? error.name : "UnknownError");
    }
  };
  const wakeQueued = (): void => {
    if (stopped || wakeInFlight) return;
    wakeInFlight = runQueueWake().finally(() => { wakeInFlight = undefined; });
  };
  const wakeTimer = setInterval(wakeQueued, QUEUE_WAKE_INTERVAL_MS);
  wakeTimer.unref?.();
  void wakeQueued();
  return {
    available: true as const,
    chatExecutionAdapter,
    async shutdown(): Promise<void> {
      stopped = true;
      clearInterval(wakeTimer);
      await wakeInFlight;
      registry.shutdown();
      await brokerServer.close();
      await client.close();
    },
  };
}

export function createSharedAiCancellationDispatcher(options: {
  policy: Pick<CollaborationPolicyClient, "getM2">;
  authority: Pick<CollaborationAuthority, "authorize">;
  orchestrator: Pick<CanonicalChatOrchestrator, "cancelSharedRun">;
}) {
  return async (input: {
    scopeId: string;
    chatId: string;
    runId: string;
    requestId: string;
    clientRequestId: string;
    actorId: string;
  }): Promise<void> => {
    const currentPolicy = await options.policy.getM2();
    const context = await options.authority.authorize({
      scopeId: input.scopeId,
      actorId: input.actorId,
      action: "control_execution",
      executionPolicy: currentPolicy,
    });
    if (context.resourceKind !== "chat" || context.resourceId !== input.chatId) {
      throw new CollaborationAuthorizationError("not_found", "Shared Chat access is required");
    }
    await options.orchestrator.cancelSharedRun(
      { type: "personal", ownerId: context.ownerId },
      input.scopeId,
      input.chatId,
      input.runId,
    );
  };
}
export function createSharedAiApprovalReconciler(options: {
  resolveOwnerId(scopeId: string, chatId: string): Promise<string>;
  readRunStatus(
    chatId: string,
    runId: string,
  ): Promise<"accepted" | "running" | "waiting_for_approval" | "waiting_for_input" | "completed" | "failed" | "aborted" | null>;
  orchestrator: Pick<CanonicalChatOrchestrator, "cancelSharedRun" | "reconcileActiveRuns">;
}) {
  return async (input: {
    commandId: string;
    scopeId: string;
    chatId: string;
    runId: string;
    approvalId: string;
    decision: "approve" | "approve_for_session" | "decline" | "cancel";
  }): Promise<"completed" | "failed"> => {
    const owner = {
      type: "personal" as const,
      ownerId: await options.resolveOwnerId(input.scopeId, input.chatId),
    };
    try {
      await options.orchestrator.cancelSharedRun(owner, input.scopeId, input.chatId, input.runId);
    } catch (error: unknown) {
      console.warn(
        "[collaboration] unknown approval run stop deferred to recovery",
        error instanceof Error ? error.name : "UnknownError",
      );
    }
    await options.orchestrator.reconcileActiveRuns(owner);
    const status = await options.readRunStatus(input.chatId, input.runId);
    if (status === "completed") return "completed";
    if (status === null || status === "failed" || status === "aborted") return "failed";
    throw new Error("Shared approval Run remains active after reconciliation");
  };
}
function eligibilityMatches(value: unknown): boolean {
  try {
    const parsed = parseCollaborationAiEligibility(value);
    return parsed.profileId === ELIGIBILITY.profileId
      && parsed.profileVersion === ELIGIBILITY.profileVersion
      && parsed.profileDigest === ELIGIBILITY.profileDigest
      && parsed.adapterId === ELIGIBILITY.adapterId
      && parsed.harnessVersion === ELIGIBILITY.harnessVersion;
  } catch (error: unknown) {
    console.warn("[collaboration] shared AI eligibility validation failed",
      error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}

async function ownerIdFor(
  db: Kysely<OwnerCollaborationDatabase>,
  scopeId: string,
  chatId: string,
): Promise<string> {
  const scope = await db.selectFrom("collaboration_scopes").select("owner_id")
    .where("id", "=", scopeId).where("kind", "=", "chat")
    .where("resource_id", "=", chatId).where("lifecycle", "=", "shared")
    .executeTakeFirst();
  if (!scope) throw new Error("Shared AI scope is unavailable");
  return scope.owner_id;
}

function scopedClient(input: {
  client: ReturnType<typeof createScopeRuntimeClient>;
  registry: SharedAiRuntimeRegistry;
  scopeId: string;
  chatId: string;
  ownerId: string;
  actorId: string;
  accessSourceId: KernelCredentialAccessSourceId;
}) {
  return {
    capability: () => input.client.capability(),
    async createRuntime(request: Parameters<typeof input.client.createRuntime>[0]) {
      const created = await input.client.createRuntime(request);
      try {
        input.registry.bind({
          runtimeHandle: created.runtimeHandle,
          scopeId: input.scopeId,
          chatId: input.chatId,
          ownerId: input.ownerId,
          actorId: input.actorId,
          executionGeneration: created.executionGeneration,
          accessSourceId: input.accessSourceId,
        });
      } catch (error: unknown) {
        await input.client.stopRuntime({ runtimeHandle: created.runtimeHandle }).catch((stopError: unknown) => {
          console.warn("[collaboration] unbound shared runtime cleanup failed",
            stopError instanceof Error ? stopError.name : "UnknownError");
        });
        throw error;
      }
      return created;
    },
    async runChat(request: Parameters<typeof input.client.runChat>[0]) {
      input.registry.selectModel(request.runtimeHandle, request.model);
      return input.client.runChat(request);
    },
    async stopRuntime(request: Parameters<typeof input.client.stopRuntime>[0]) {
      input.registry.release(request.runtimeHandle);
      return input.client.stopRuntime(request);
    },
  };
}
