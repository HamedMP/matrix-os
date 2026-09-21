import {
  CanonicalChatModelSelectionSchema,
  type CanonicalChatModelSelection,
  type CanonicalProviderDriverKind,
} from "@matrix-os/contracts";
import {
  SCOPE_RUNTIME_HARNESS_VERSION,
  SCOPE_RUNTIME_CODEX_VERSION,
  SCOPE_RUNTIME_PROFILE_DIGEST,
  SCOPE_RUNTIME_PROFILE_ID,
  SCOPE_RUNTIME_PROFILE_VERSION,
} from "@matrix-os/scope-runtime/profile";
import type { Kysely } from "kysely";
import type { CanonicalChatOrchestrator } from "../chat/orchestrator.js";
import {
  validateChatProviderSelection,
  type ChatProviderCatalogService,
} from "../chat/provider-catalog.js";
import { SharedChatRunPreparationError } from "../chat/shared-execution-coordinator.js";
import { CollaborationChatCommands } from "../chat/collaboration-commands.js";
import type { ChatRepository } from "../chat/repository.js";
import type { CodingAgentProviderRegistry } from "../coding-agents/provider-registry.js";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import {
  resolveKernelCredentialSources,
  type KernelCredentialAccessSourceId,
  type KernelCredentialObservationState,
  type KernelCredentialSources,
} from "../kernel-credentials.js";
import {
  CollaborationAuthorizationError,
  type CollaborationAuthority,
} from "./authority.js";
import {
  CollaborationChatExecutionAdapter,
} from "./chat-execution-adapter.js";
import {
  parseCollaborationAiEligibility,
  sharedAiAdapterFor,
  type CollaborationAiExecutionEligibility,
} from "./shared-ai-eligibility.js";
import type { CollaborationChatScopeService } from "./chat-scope.js";
import type { OwnerCollaborationDatabase } from "./database.js";
import type { CollaborationEventRegistry } from "./events.js";
import { createScopeRuntimeBroker, createScopeRuntimeBrokerServer } from "./scope-runtime-broker.js";
import { createHash } from "node:crypto";
import type { CanonicalChatExecutionRootRef, CollaborationRunInterruptionReason } from "@matrix-os/contracts";
import type { ScopeRuntimeSandboxManifest } from "@matrix-os/scope-runtime";
import type { ChatExecutionRootResolver } from "../chat/execution-root.js";
import type { SharedDispatchRun } from "../chat/shared-execution-coordinator.js";
import type { SandboxRuntimeRegistry } from "./revocation-enforcer.js";
import { CollaborationRunBindingError } from "./run-account-binding.js";
import { createSharedClaudeAdapter } from "./shared-claude-adapter.js";
import { createSharedCodexAdapter } from "./shared-codex-adapter.js";
import {
  interruptActiveSharedRuns,
  markLostSharedRunsOnStartup,
  type CollaborationRunLossRepository,
} from "./shared-run-loss.js";
import {
  createScopeRuntimeClient,
  type ScopeRuntimeProfileCatalog,
} from "./scope-runtime-client.js";
import { SharedAiRuntimeRegistry } from "./shared-ai-runtime-registry.js";
import type { CollaborationActorProofVerifier } from "./actor-proof.js";
import type { SharedRunOwnerSource } from "./shared-run-owner-source.js";
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
      codex: {
        harnessVersions: [SCOPE_RUNTIME_CODEX_VERSION],
        workloads: ["chat_ai"],
      },
    },
  },
};
const ELIGIBILITY: CollaborationAiExecutionEligibility = {
  profileId: SCOPE_RUNTIME_PROFILE_ID,
  profileVersion: SCOPE_RUNTIME_PROFILE_VERSION,
  profileDigest: SCOPE_RUNTIME_PROFILE_DIGEST,
  adapters: [
    { adapterId: "claude-code", harnessVersion: SCOPE_RUNTIME_HARNESS_VERSION },
    { adapterId: "codex", harnessVersion: SCOPE_RUNTIME_CODEX_VERSION },
  ],
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
  providerCatalog?: ChatProviderCatalogService;
  codingProviders?: Pick<CodingAgentProviderRegistry, "listProviders">;
  /** S08: owner-selected source decision consulted before every shared adapter is prepared. */
  ownerSource?: SharedRunOwnerSource;
  /** S09: immutable loss and control records; required for interrupted-run attribution. */
  runLoss?: CollaborationRunLossRepository;
  /** S07: registry that stops sandboxed runtimes when the requesting actor loses its lease. */
  sandboxRuntimes?: Pick<SandboxRuntimeRegistry, "bind" | "release">;
  /** S09: resolves a rooted Chat's project/worktree to the host path the sandbox mounts. */
  executionRoots?: Pick<ChatExecutionRootResolver, "resolve">;
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
  const eligibility: CollaborationAiExecutionEligibility = {
    ...ELIGIBILITY,
    adapters: ELIGIBILITY.adapters.filter((expected) => capability.supportedAdapters.some((actual) =>
      actual.adapterId === expected.adapterId
      && actual.harnessVersion === expected.harnessVersion
      && actual.workloads.includes("chat_ai"))),
  };
  if (eligibility.adapters.length === 0) {
    await options.chatScope.reconcileExecutionEligibility({ executionGeneration: null, eligibility: null });
    await client.close();
    return { available: false as const, async shutdown(): Promise<void> {} };
  }
  await options.chatScope.reconcileExecutionEligibility({ executionGeneration, eligibility });
  const registry = new SharedAiRuntimeRegistry();
  const resolveAccessSource = options.resolveAccessSource
    ?? (async () => (await resolveKernelCredentialSources(
      options.homePath,
      process.env,
      options.fundedCredentialProvider,
    )).selectedAccessSourceId);
  const commands = new CollaborationChatCommands({
    db: options.db,
    ...(options.runLoss ? { runControls: options.runLoss } : {}),
    submitApproval: async () => {
      throw new Error("The fixed shared Chat adapter does not expose approval callbacks");
    },
    submitCancellation: createSharedAiCancellationDispatcher({
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
    await options.orchestrator.dispatchNextSharedQueued(
      { type: "personal", ownerId: await ownerIdFor(options.db, scopeId, chatId) },
      chatId,
      scopeId,
      async (execution, run) => {
        try {
          const context = await options.authority.authorize({
            scopeId,
            actorId: execution.requestingActorId,
            action: "request_ai",
          });
          if (context.resourceId !== chatId || context.ownerId.length === 0
            || execution.executionGeneration !== executionGeneration
            || !eligibilityMatches(execution.executionEligibility, eligibility)) {
            throw new SharedChatRunPreparationError("unavailable");
          }
          const dispatchFence = await options.db.selectFrom("collaboration_scopes as scope")
            .innerJoin("chats as chat", "chat.id", "scope.resource_id")
            .select([
              "scope.owner_id", "scope.resource_id", "scope.execution_generation",
              "scope.execution_eligibility", "chat.lifecycle", "chat.bound_driver_kind",
              "chat.bound_instance_id", "chat.current_selection",
            ])
            .where("scope.id", "=", scopeId)
            .where("scope.kind", "=", "chat")
            .where("scope.lifecycle", "=", "shared")
            .whereRef("chat.owner_id", "=", "scope.owner_id")
            .whereRef("chat.owner_type", "=", "scope.owner_type")
            .executeTakeFirst();
          if (!sharedDispatchFenceMatches(dispatchFence, {
            ownerId: context.ownerId,
            chatId,
            executionGeneration: execution.executionGeneration,
            executionEligibility: execution.executionEligibility,
            driverKind: execution.driverKind,
            selection: execution.selection,
          })) throw new SharedChatRunPreparationError("unavailable");
          const adapter = sharedAdapterFor(execution.driverKind, execution.selection.instanceId, eligibility);
          if (!adapter) throw new SharedChatRunPreparationError("unavailable");
          // S08: the owner's execution policy decides the source; a member on an owner-only
          // scope or an unavailable source refuses preparation and keeps the queued request.
          const ownerDecision = options.ownerSource
            ? await options.ownerSource.prepare({
                scopeId,
                chatId,
                ownerId: context.ownerId,
                requestingActorId: execution.requestingActorId,
                driverKind: execution.driverKind,
              })
            : null;
          const providerIdentity = execution.driverKind === "codex"
            ? { driverKind: "codex" as const, instanceId: "codex_default" as const }
            : {
                driverKind: "claude_code" as const,
                instanceId: "claude_shared" as const,
                accessSourceId: ownerDecision?.accessSourceId ?? await resolveAccessSource(),
              };
          // S09: a rooted run mounts the owner's project or worktree through the S07
          // sandbox; without the sandbox capability or a root resolver it is unavailable.
          const sandbox = await sandboxManifestFor({
            run,
            scopeId,
            actorId: execution.requestingActorId,
            capability: client.capability(),
            executionRoots: options.executionRoots,
            owner: { type: "personal", ownerId: context.ownerId },
          });
          // S08/S09: pin actor, owner, source, policy revision, audience and root per run
          // before any provider work; a refusal keeps the queued request in place.
          if (ownerDecision && options.ownerSource?.bindings) {
            await admitRun({
              bindings: options.ownerSource.bindings,
              run,
              scopeId,
              chatId,
              requestId: execution.queuedTurnId,
              requestingActorId: execution.requestingActorId,
              policyRevision: ownerDecision.policyRevision,
              audienceGeneration: String(execution.authorityGeneration),
              harness: ownerDecision.harness,
              modelId: execution.selection.model,
              rootFingerprint: sandbox?.worktree.fingerprint ?? run.executionRootFingerprint ?? null,
            });
          }
          const factory = adapter.adapterId === "codex" ? createSharedCodexAdapter : createSharedClaudeAdapter;
          return factory({
            client: scopedClient({
              client,
              registry,
              scopeId,
              chatId,
              ownerId: context.ownerId,
              actorId: context.actorId,
              providerIdentity,
            }),
            scopeId,
            executionGeneration: capability.executionGeneration,
            harnessVersion: adapter.harnessVersion,
            ...(sandbox ? { sandbox } : {}),
            ...(options.sandboxRuntimes ? { runtimes: options.sandboxRuntimes } : {}),
            onLoss: (reason) => {
              void recordLoss(options.runLoss, {
                runId: run.id, scopeId, chatId, requestId: execution.queuedTurnId,
                requestingActorId: execution.requestingActorId, reason,
              });
            },
          });
        } catch (error: unknown) {
          if (error instanceof SharedChatRunPreparationError) throw error;
          if (error instanceof CollaborationRunBindingError) {
            throw new SharedChatRunPreparationError(error.code === "owner_only" ? "unauthorized" : "unavailable");
          }
          if (error instanceof CollaborationAuthorizationError) {
            throw new SharedChatRunPreparationError(
              error.code === "not_found" || error.code === "forbidden" ? "unauthorized" : "unavailable",
            );
          }
          console.warn("[collaboration] shared AI preparation unavailable",
            error instanceof Error ? error.name : "UnknownError");
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
        || !eligibilityMatches(scope.execution_eligibility, eligibility)) {
        throw new Error("Shared AI execution eligibility changed");
      }
      return scope.execution_eligibility;
    },
    resolveProviderReadiness: (ownerId, selection, boundDriverKind) => resolveSharedProviderReadiness({
      resolveCredentialSources: () => resolveKernelCredentialSources(
        options.homePath,
        process.env,
        options.fundedCredentialProvider,
      ),
      ...(options.codingProviders ? { codingProviders: options.codingProviders } : {}),
      ...(options.providerCatalog ? { providerCatalog: options.providerCatalog } : {}),
    }, ownerId, selection, boundDriverKind),
    ...(options.providerCatalog ? {
      resolveCanonicalProviderAuthority: async (ownerId, selection) => {
        const catalog = await options.providerCatalog!.getCatalog({ userId: ownerId, source: "jwt" });
        const validated = validateChatProviderSelection({
          catalog,
          selection,
          requirements: SHARED_RUN_SELECTION_REQUIREMENTS,
        });
        if (!validated.ok) return null;
        // The owner's first binding may only name a driver this runtime can
        // execute in isolation; the queue re-verifies the signed eligibility.
        const adapterId = sharedAiAdapterFor(validated.instance.driverKind, validated.selection.instanceId);
        if (!adapterId || !eligibility.adapters.some((adapter) => adapter.adapterId === adapterId)) {
          return null;
        }
        return { driverKind: validated.instance.driverKind, selection: validated.selection };
      },
    } : {}),
    requestDispatch: dispatch,
    onCommitted: (scopeId) => options.eventRegistry.broadcastScope(scopeId),
    ...(options.runLoss ? { runLoss: options.runLoss } : {}),
  });

  const broker = createScopeRuntimeBroker({
    homePath: options.homePath,
    fundedCredentialProvider: options.fundedCredentialProvider,
    authorize: async (request) => {
      const binding = registry.lookup(request);
      if (!binding) return { allowed: false };
      try {
        const context = await options.authority.authorize({
          scopeId: binding.scopeId,
          actorId: binding.actorId,
          action: "request_ai",
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
  let lostRunsMarked = false;
  const runQueueWake = async (): Promise<void> => {
    try {
      if (!lostRunsMarked && options.runLoss) {
        // Every shared run still active in the database was lost with the previous process.
        await markLostSharedRunsOnStartup({ db: options.db, loss: options.runLoss });
        lostRunsMarked = true;
      }
      await recoverSharedAiQueue({
        reconcilePendingApprovals: async () => {
          await commands.reconcilePendingApprovals();
        },
        listQueued: async () => {
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
          return rows.map((row) => ({ scopeId: row.scope_id, chatId: row.chat_id }));
        },
        dispatch,
      });
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
    /**
     * S09: the home lost its control authority (or its scope runtime): every
     * active shared run is recorded as lost and stopped; queued requests are
     * preserved and re-admit on fresh membership once control returns.
     */
    async interruptForLoss(reason: CollaborationRunInterruptionReason): Promise<string[]> {
      if (!options.runLoss) return [];
      return interruptActiveSharedRuns({
        db: options.db,
        loss: options.runLoss,
        reason,
        orchestrator: options.orchestrator,
      });
    },
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

const SHARED_RUN_SELECTION_REQUIREMENTS = { interactionMode: "default", permissionMode: "supervised" } as const;

export type SharedProviderReadiness = "ready" | "reconnect_required" | "unavailable";

interface SharedProviderReadinessInput {
  resolveCredentialSources(): Promise<KernelCredentialSources>;
  codingProviders?: Pick<CodingAgentProviderRegistry, "listProviders">;
  providerCatalog?: Pick<ChatProviderCatalogService, "getCatalog">;
}

/**
 * Readiness follows the immutable bound driver, never an Instance id: the
 * catalog does not reserve ids per driver, so a Claude binding may legitimately
 * use any Instance id. An unbound Chat has no bound driver yet, so its candidate
 * selection is classified through the trusted server-side catalog (a `codex`
 * Instance takes the Codex route); without a catalog it follows the Claude
 * default, and first-binding authority still requires a catalog to bind.
 */
export async function resolveSharedProviderReadiness(
  input: SharedProviderReadinessInput,
  ownerId: string,
  selection?: CanonicalChatModelSelection | null,
  boundDriverKind?: CanonicalProviderDriverKind | null,
): Promise<SharedProviderReadiness> {
  if (boundDriverKind === "codex") {
    return selection ? resolveCodexProviderReadiness(input, ownerId, selection) : "unavailable";
  }
  if (boundDriverKind || !input.providerCatalog || !selection) {
    return resolveClaudeProviderReadiness(input, ownerId, selection);
  }
  const catalog = await input.providerCatalog.getCatalog({ userId: ownerId, source: "jwt" });
  const cached = { getCatalog: async () => catalog };
  const candidate = catalog.instances.find((instance) => instance.id === selection.instanceId);
  return candidate?.driverKind === "codex"
    ? resolveCodexProviderReadiness({ providerCatalog: cached }, ownerId, selection)
    : resolveClaudeProviderReadiness({ ...input, providerCatalog: cached }, ownerId, selection);
}

/**
 * Codex owner identity lives in the owner's Codex auth file and is refreshed by
 * the scope broker at inference time, so readiness is verified only through the
 * trusted server-side provider catalog. Without a catalog it fails closed. An
 * unauthenticated Codex Instance reports generic unavailability: the owner
 * reconnect guidance names Claude credentials and must not be shown for Codex.
 */
async function resolveCodexProviderReadiness(
  input: Pick<SharedProviderReadinessInput, "providerCatalog">,
  ownerId: string,
  selection: CanonicalChatModelSelection,
): Promise<SharedProviderReadiness> {
  if (!input.providerCatalog) return "unavailable";
  const catalog = await input.providerCatalog.getCatalog({ userId: ownerId, source: "jwt" });
  const validated = validateChatProviderSelection({
    catalog,
    selection,
    requirements: SHARED_RUN_SELECTION_REQUIREMENTS,
  });
  return validated.ok && validated.instance.driverKind === "codex" ? "ready" : "unavailable";
}

/**
 * Readiness follows the kernel credential access source the scoped run will
 * actually use (see `scope-runtime-broker`): Matrix-included access, the owner's
 * API key, or the owner's Claude profile. Matrix-included access is platform
 * managed and needs no probe. Owner routes are never ready on credential material
 * alone: the trusted server-side provider catalog must validate the complete
 * bound selection (Instance, model, options, shared-run requirements), and an
 * `authentication_required` Instance maps to reconnect guidance. Without a
 * catalog, the owner-profile route falls back to the Claude login state and the
 * owner API key route fails closed.
 */
export async function resolveClaudeProviderReadiness(
  input: SharedProviderReadinessInput,
  ownerId: string,
  selection?: CanonicalChatModelSelection | null,
): Promise<SharedProviderReadiness> {
  const sources = await input.resolveCredentialSources();
  if (sources.selectedAccessSourceId === "matrix_included") {
    return sources.matrixIncluded.state === "ready" ? "ready" : "unavailable";
  }
  const observed = sources.selectedAccessSourceId === "owner_anthropic_key"
    ? sources.ownerApiKey.state
    : sources.ownerProfile.state;
  if (!usableCredentialState(observed)) return "unavailable";
  if (input.providerCatalog && selection) {
    // Validate the complete canonical selection (Instance, model, options, and
    // shared-run requirements) exactly as the first-binding path does, so a
    // removed or disabled model never reports ready.
    const catalog = await input.providerCatalog.getCatalog({ userId: ownerId, source: "jwt" });
    const validated = validateChatProviderSelection({
      catalog,
      selection,
      requirements: SHARED_RUN_SELECTION_REQUIREMENTS,
    });
    if (validated.ok) return validated.instance.driverKind === "claude_code" ? "ready" : "unavailable";
    const instance = catalog.instances.find((candidate) => candidate.id === selection.instanceId);
    return instance?.driverKind === "claude_code" && instance.unavailabilityReason === "authentication_required"
      ? "reconnect_required"
      : "unavailable";
  }
  if (sources.selectedAccessSourceId === "owner_anthropic_profile" && input.codingProviders) {
    const summaries = await input.codingProviders.listProviders({ userId: ownerId, source: "jwt" });
    const claude = summaries.find((provider) => provider.id === "claude" || provider.kind === "claude");
    if (claude?.availability === "available" && claude.authStatus === "authenticated") return "ready";
    if (claude?.availability === "auth_required" || claude?.authStatus === "expired") {
      return "reconnect_required";
    }
  }
  return "unavailable";
}

function usableCredentialState(state: KernelCredentialObservationState): boolean {
  return state === "ready" || state === "unverified";
}

export async function recoverSharedAiQueue(options: {
  reconcilePendingApprovals(): Promise<void>;
  listQueued(): Promise<readonly { scopeId: string; chatId: string }[]>;
  dispatch(scopeId: string, chatId: string): Promise<void>;
}): Promise<void> {
  await options.reconcilePendingApprovals();
  const rows = await options.listQueued();
  if (rows.length === 0) return;
  const scopes: Record<string, { scopeId: string; chatId: string }> = Object.create(null) as Record<
    string,
    { scopeId: string; chatId: string }
  >;
  for (const row of rows) scopes[row.scopeId] ??= row;
  await Promise.allSettled(Object.values(scopes).map((row) => options.dispatch(row.scopeId, row.chatId)));
}

export function createSharedAiCancellationDispatcher(options: {
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
    const context = await options.authority.authorize({
      scopeId: input.scopeId,
      actorId: input.actorId,
      action: "control_execution",
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
function eligibilityMatches(
  value: unknown,
  expected: CollaborationAiExecutionEligibility = ELIGIBILITY,
): boolean {
  try {
    const parsed = parseCollaborationAiEligibility(value);
    return parsed.profileId === expected.profileId
      && parsed.profileVersion === expected.profileVersion
      && parsed.profileDigest === expected.profileDigest
      && JSON.stringify(parsed.adapters) === JSON.stringify(expected.adapters);
  } catch (error: unknown) {
    console.warn("[collaboration] shared AI eligibility validation failed",
      error instanceof Error ? error.name : "UnknownError");
    return false;
  }
}

function sharedAdapterFor(
  driverKind: CanonicalProviderDriverKind,
  instanceId: string,
  eligibility: CollaborationAiExecutionEligibility,
): CollaborationAiExecutionEligibility["adapters"][number] | undefined {
  const adapterId = sharedAiAdapterFor(driverKind, instanceId);
  return adapterId ? eligibility.adapters.find((adapter) => adapter.adapterId === adapterId) : undefined;
}

export function sharedDispatchFenceMatches(
  current: {
    owner_id: string;
    resource_id: string;
    execution_generation: number | null;
    execution_eligibility: unknown;
    lifecycle: string;
    bound_driver_kind: string | null;
    bound_instance_id: string | null;
    current_selection: unknown;
  } | undefined,
  expected: {
    ownerId: string;
    chatId: string;
    executionGeneration: number;
    executionEligibility: unknown;
    driverKind: CanonicalProviderDriverKind;
    selection: { instanceId: string; model: string };
  },
): boolean {
  if (!current || current.owner_id !== expected.ownerId || current.resource_id !== expected.chatId
    || current.lifecycle !== "active"
    || Number(current.execution_generation) !== expected.executionGeneration
    || current.bound_driver_kind !== expected.driverKind
    || current.bound_instance_id !== expected.selection.instanceId
    || !eligibilityMatches(current.execution_eligibility, parseCollaborationAiEligibility(
      expected.executionEligibility,
    ))) return false;
  try {
    const raw = typeof current.current_selection === "string"
      ? JSON.parse(current.current_selection) as unknown
      : current.current_selection;
    const selection = CanonicalChatModelSelectionSchema.parse(raw);
    return JSON.stringify(selection) === JSON.stringify(expected.selection);
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw new Error("Invalid shared execution selection");
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
  providerIdentity:
    | { driverKind: "claude_code"; instanceId: "claude_shared"; accessSourceId: KernelCredentialAccessSourceId }
    | { driverKind: "codex"; instanceId: "codex_default" };
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
          providerIdentity: input.providerIdentity,
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

async function recordLoss(
  loss: CollaborationRunLossRepository | undefined,
  input: Parameters<CollaborationRunLossRepository["recordInterruption"]>[0],
): Promise<void> {
  if (!loss) return;
  try {
    await loss.recordInterruption(input);
  } catch (error: unknown) {
    console.warn("[collaboration] shared run loss record failed",
      error instanceof Error ? error.name : "UnknownError");
  }
}

async function sandboxManifestFor(input: {
  run: SharedDispatchRun;
  scopeId: string;
  actorId: string;
  capability: ReturnType<ReturnType<typeof createScopeRuntimeClient>["capability"]>;
  executionRoots: Pick<ChatExecutionRootResolver, "resolve"> | undefined;
  owner: { type: "personal"; ownerId: string };
}): Promise<ScopeRuntimeSandboxManifest | undefined> {
  if (!input.run.executionRoot) return undefined;
  if (!input.executionRoots || !input.capability.available || !input.capability.sandbox
    || !input.capability.sandbox.workloads.includes("chat_ai")) {
    throw new SharedChatRunPreparationError("unavailable");
  }
  const resolved = await input.executionRoots.resolve(input.owner, input.run.executionRoot);
  if (input.run.executionRootFingerprint && resolved.fingerprint !== input.run.executionRootFingerprint) {
    throw new SharedChatRunPreparationError("unavailable");
  }
  return {
    version: 1,
    scopeHandle: `scope_${input.scopeId.replaceAll("-", "")}`,
    actorId: input.actorId,
    worktree: { hostPath: resolved.primaryWorkspaceRoot, mode: "rw", fingerprint: resolved.fingerprint },
    network: "broker_only",
  };
}

async function admitRun(input: {
  bindings: NonNullable<SharedRunOwnerSource["bindings"]>;
  run: SharedDispatchRun;
  scopeId: string;
  chatId: string;
  requestId: string;
  requestingActorId: string;
  policyRevision: string;
  audienceGeneration: string;
  harness: "codex" | "claude_code";
  modelId: string;
  rootFingerprint: string | null;
}): Promise<void> {
  const executionRoot: CanonicalChatExecutionRootRef | null = input.run.executionRoot ?? null;
  await input.bindings.admit({
    runId: input.run.id,
    requestId: input.requestId,
    scopeId: input.scopeId,
    requestingActorId: input.requestingActorId,
    expectedPolicyRevision: input.policyRevision,
    executionRoot,
    rootFingerprint: input.rootFingerprint
      ?? createHash("sha256").update(`no-root:${input.chatId}`).digest("hex"),
    audienceGeneration: input.audienceGeneration,
    harness: input.harness,
    modelId: input.modelId,
  });
}
