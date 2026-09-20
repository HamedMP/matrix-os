import { sql, type Kysely } from "kysely";
import type { GatewayCollaborationConfig } from "./config.js";
import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { ChatRepository } from "../chat/repository.js";
import type { CanonicalChatOrchestrator } from "../chat/orchestrator.js";
import type { ChatProviderCatalogService } from "../chat/provider-catalog.js";
import type { CodingAgentProviderRegistry } from "../coding-agents/provider-registry.js";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import { CollaborationActorProofVerifier } from "./actor-proof.js";
import { CollaborationAuthority } from "./authority.js";
import { CollaborationChatAdapter } from "./chat-adapter.js";
import { CollaborationChatScopeService } from "./chat-scope.js";
import { bootstrapCollaborationDatabase, type OwnerCollaborationDatabase } from "./database.js";
import { CollaborationDirectoryOutbox } from "./directory-outbox.js";
import { CollaborationDiscussionAdapter } from "./discussion-adapter.js";
import { registerCollaborationEventWebSocketRoute } from "./event-websocket-route.js";
import { CollaborationEventRegistry } from "./events.js";
import { CollaborationParticipantResolver } from "./participant-resolver.js";
import {
  createOrganizationPrecondition,
  type OrganizationMembershipSource,
  type OrganizationPrecondition,
} from "./organization-precondition.js";
import { CollaborationRepository } from "./repository.js";
import { createCollaborationRoutes } from "./routes.js";
import { createSharedAiRuntime } from "./shared-ai-runtime.js";
import type { CollaborationChatExecutionAdapter } from "./chat-execution-adapter.js";
import { CollaborationTerminalAdapter } from "./terminal-adapter.js";
import { TerminalControlCoordinator } from "./terminal-control.js";
import { CollaborationTerminalDispatcher } from "./terminal-dispatcher.js";
import { CollaborationTerminalEventRegistry } from "./terminal-events.js";
import { registerCollaborationTerminalWebSocketRoute } from "./terminal-websocket-route.js";
import { createProjectTransitionJournal } from "./project-transition.js";
import { createProjectFence } from "./project-fence.js";
import { createProjectInheritanceResolver } from "./project-inheritance.js";
import {
  createCollaborationProjectLifecycle,
  type ProjectDeletionDriver,
  type ProjectTransferStager,
} from "./project-lifecycle.js";
import {
  createProjectInventoryService,
  type ProjectInventoryResourceSource,
} from "./project-inventory.js";
import { createProjectSharingService, type ProjectSharingService } from "./project-sharing.js";
import { createProjectTransitionCoordinator } from "./project-transition-coordinator.js";
import {
  CollaborationProjectScopeService,
  type CollaborationProjectSource,
} from "./project-scope.js";

const ARTIFACT_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const ARTIFACT_CLEANUP_BATCH_SIZE = 1_000;

export {
  describeGatewayCollaborationConfiguration,
  loadGatewayCollaborationConfig,
  type GatewayCollaborationConfig,
  type GatewayCollaborationConfigurationFailure,
  type GatewayCollaborationConfigurationHealth,
} from "./config.js";
export { registerFailClosedCollaborationRoutes } from "./fail-closed.js";
export { constructGatewayCollaborationOrFailClosed } from "./construct.js";
export {
  createOrganizationPrecondition,
  type OrganizationMembershipAssertion,
  type OrganizationMembershipSource,
  type OrganizationPrecondition,
} from "./organization-precondition.js";

export async function createGatewayCollaboration(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  chatRepository: ChatRepository;
  config: GatewayCollaborationConfig;
  resolveParticipant?(actorId: string): Promise<{ actorId: string; displayName: string }>;
  resolveInvitationIdentifier?(identifier: string): Promise<{ actorId: string; displayName: string }>;
  outboxFetch?: typeof fetch;
  projectLifecycleDrivers?: {
    stageTransfer: ProjectTransferStager;
    deleteProject: ProjectDeletionDriver;
  };
  startTimers?: boolean;
  projectSource?: CollaborationProjectSource;
  /**
   * Optional membership source registered at construction. Production leaves
   * this unset until the S03 projection registers itself, so every request
   * is denied by the organization precondition (S20).
   */
  organizationMembershipSource?: OrganizationMembershipSource;
  organizationPrecondition?: OrganizationPrecondition;
}) {
  await bootstrapCollaborationDatabase(options.db);
  await cleanupExpiredArtifacts(options.db, new Date());
  const repository = new CollaborationRepository(options.db, { chatRepository: options.chatRepository });
  const participantResolver = options.resolveParticipant && options.resolveInvitationIdentifier
    ? undefined
    : new CollaborationParticipantResolver({
      platformBaseUrl: options.config.platformBaseUrl,
      runtimeId: options.config.runtimeId,
      serviceToken: options.config.serviceToken,
    });
  const resolveParticipant = options.resolveParticipant
    ?? ((actorId: string) => participantResolver!.resolve(actorId));
  const resolveInvitationIdentifier = options.resolveInvitationIdentifier
    ?? ((identifier: string) => participantResolver!.resolveInvitationIdentifier(identifier));
  const organizationPrecondition = options.organizationPrecondition
    ?? createOrganizationPrecondition(options.organizationMembershipSource
      ? { source: options.organizationMembershipSource }
      : {});
  const authority = new CollaborationAuthority(repository, { organizationPrecondition });
  const verifier = new CollaborationActorProofVerifier({
    runtimeId: options.config.runtimeId,
    keys: options.config.proofKeys,
    authority,
  });
  const chatScope = new CollaborationChatScopeService(options.db, {
    runtimeId: options.config.runtimeId,
    preflightSecret: options.config.preflightSecret,
  });
  const projectTransitions = createProjectTransitionJournal({ db: options.db });
  const projectFence = createProjectFence({ db: options.db, transitions: projectTransitions });
  const projectLifecycle = options.projectLifecycleDrivers
    ? createCollaborationProjectLifecycle({ db: options.db, ...options.projectLifecycleDrivers })
    : undefined;
  if (projectLifecycle) await projectLifecycle.recoverPending();
  const projectScope = options.projectSource ? new CollaborationProjectScopeService(options.db, {
    runtimeId: options.config.runtimeId,
    preflightSecret: options.config.preflightSecret,
    source: options.projectSource,
  }) : undefined;
  const outbox = new CollaborationDirectoryOutbox({
    db: options.db,
    platformBaseUrl: options.config.platformBaseUrl,
    runtimeId: options.config.runtimeId,
    serviceToken: options.config.serviceToken,
    ...(options.outboxFetch ? { fetchImpl: options.outboxFetch } : {}),
    startTimer: options.startTimers,
  });
  const eventRegistry = new CollaborationEventRegistry({
    db: options.db,
    authorize: (scopeId, actorId) => authority.authorize({ scopeId, actorId, action: "read" }),
    startTimers: options.startTimers,
  });
  const chatAdapter = new CollaborationChatAdapter({
    db: options.db,
    authority,
    resolveParticipant,
    onCommitted: (scopeId) => eventRegistry.broadcastScope(scopeId),
  });
  const discussionAdapter = new CollaborationDiscussionAdapter({
    db: options.db,
    authority,
    chatAdapter,
    resolveParticipant,
    onCommitted: (scopeId) => eventRegistry.broadcastScope(scopeId),
  });
  const cleanupTimer = options.startTimers === false ? undefined : setInterval(() => {
    void cleanupExpiredArtifacts(options.db, new Date()).catch((error: unknown) => {
      console.warn("[collaboration] artifact cleanup failed", error instanceof Error ? error.name : "UnknownError");
    });
  }, ARTIFACT_CLEANUP_INTERVAL_MS);
  cleanupTimer?.unref?.();
  let registered = false;
  let closing = false;
  let chatExecutionAdapter: CollaborationChatExecutionAdapter | undefined;
  let sharedAiRuntime: Awaited<ReturnType<typeof createSharedAiRuntime>> | undefined;
  let terminalAdapter: CollaborationTerminalAdapter | undefined;
  let terminalControl: TerminalControlCoordinator | undefined;
  let terminalDispatcher: CollaborationTerminalDispatcher | undefined;
  let terminalEventRegistry: CollaborationTerminalEventRegistry | undefined;
  let projectSharing: ProjectSharingService | undefined;
  let projectTransitionCoordinator: ReturnType<typeof createProjectTransitionCoordinator> | undefined;

  return {
    repository,
    authority,
    organizationPrecondition,
    verifier,
    eventRegistry,
    chatScope,
    chatAdapter,
    discussionAdapter,
    outbox,
    collaborationGuard: chatScope,
    projectTransitions,
    projectFence,
    projectScope,
    projectOperationAdmission: {
      withLegacyAdmission<T>(input: {
        ownerType: "personal" | "organization";
        ownerId: string;
        projectId: string;
        kind: "write" | "run";
      }, operation: () => Promise<T>): Promise<T> {
        return projectFence.withLegacyAdmission({
          ...input,
          authorityRuntimeId: options.config.runtimeId,
        }, () => operation());
      },
    },
    async enableSharedAi(input: {
      orchestrator: CanonicalChatOrchestrator;
      homePath: string;
      fundedCredentialProvider?: MatrixFundedCredentialProvider;
      supervisorSocket?: string;
      brokerSocket?: string;
      fetchImpl?: typeof fetch;
      providerCatalog?: ChatProviderCatalogService;
      codingProviders?: Pick<CodingAgentProviderRegistry, "listProviders">;
    }): Promise<{ available: boolean }> {
      if (registered || closing || sharedAiRuntime) {
        throw new Error("Shared AI must be initialized exactly once before route registration");
      }
      sharedAiRuntime = await createSharedAiRuntime({
        db: options.db,
        repository: options.chatRepository,
        chatScope,
        authority,
        verifier,
        eventRegistry,
        orchestrator: input.orchestrator,
        platformBaseUrl: options.config.platformBaseUrl,
        runtimeId: options.config.runtimeId,
        serviceToken: options.config.serviceToken,
        homePath: input.homePath,
        resolveParticipant,
        ...(input.providerCatalog ? { providerCatalog: input.providerCatalog } : {}),
        ...(input.codingProviders ? { codingProviders: input.codingProviders } : {}),
        ...(input.fundedCredentialProvider ? { fundedCredentialProvider: input.fundedCredentialProvider } : {}),
        ...(input.supervisorSocket ? { supervisorSocket: input.supervisorSocket } : {}),
        ...(input.brokerSocket ? { brokerSocket: input.brokerSocket } : {}),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
      if (sharedAiRuntime.available) chatExecutionAdapter = sharedAiRuntime.chatExecutionAdapter;
      return { available: sharedAiRuntime.available };
    },
    enableSharedTerminal(input: {
      registry: ConstructorParameters<typeof CollaborationTerminalAdapter>[0]["registry"];
      runtime: ConstructorParameters<typeof CollaborationTerminalAdapter>[0]["runtime"];
      executionEligibility: ConstructorParameters<typeof CollaborationTerminalAdapter>[0]["executionEligibility"];
    }): { available: true } {
      if (registered || closing || terminalAdapter) {
        throw new Error("Shared terminal must be initialized exactly once before route registration");
      }
      terminalAdapter = new CollaborationTerminalAdapter({
        repository,
        registry: input.registry,
        runtime: input.runtime,
        runtimeId: options.config.runtimeId,
        executionEligibility: input.executionEligibility,
        preflightSecret: options.config.preflightSecret,
      });
      terminalControl = new TerminalControlCoordinator({
        startTimer: options.startTimers,
        onChanged: ({ scopeId }) => terminalEventRegistry?.publishState(scopeId),
      });
      terminalDispatcher = new CollaborationTerminalDispatcher({
        authority,
        terminal: terminalAdapter,
        control: terminalControl,
        resolveParticipant,
      });
      terminalEventRegistry = new CollaborationTerminalEventRegistry({
        authorize: (scopeId, actorId) => authority.authorize({ scopeId, actorId, action: "read" }),
        getTerminal: (scopeId, terminalId) => terminalAdapter!.get(scopeId, terminalId),
        projectTerminal: (metadata) => terminalDispatcher!.project(metadata),
        startTimers: options.startTimers,
      });
      return { available: true };
    },
    async enableSharedProject(input: {
      homePath: string;
      inventorySource: ProjectInventoryResourceSource;
    }): Promise<{ available: true }> {
      if (registered || closing || projectSharing) {
        throw new Error("Shared project must be initialized exactly once before route registration");
      }
      const inventory = createProjectInventoryService({
        homePath: input.homePath,
        source: input.inventorySource,
        confirmationSecret: options.config.preflightSecret,
      });
      projectTransitionCoordinator = createProjectTransitionCoordinator({
        db: options.db,
        transitions: projectTransitions,
        fence: projectFence,
        inheritance: createProjectInheritanceResolver({ db: options.db }),
        inventory,
      });
      await projectTransitionCoordinator.recover();
      projectSharing = createProjectSharingService({
        db: options.db,
        inventory,
        transitions: projectTransitions,
        onPrepared: (transition) => projectTransitionCoordinator!.schedule(transition.id),
        resolveDestination: async ({ scopeId, ownerId, projectId }) => {
          const scope = await options.db.selectFrom("collaboration_scopes")
            .select(["authority_runtime_id", "authority_generation"])
            .where("id", "=", scopeId)
            .where("owner_id", "=", ownerId)
            .where("kind", "=", "project")
            .where("resource_id", "=", projectId)
            .where("deleted_at", "is", null)
            .executeTakeFirst();
          if (!scope || scope.authority_runtime_id !== options.config.runtimeId) {
            throw new Error("ProjectAuthorityUnavailable");
          }
          return {
            runtimeId: options.config.runtimeId,
            authorityGeneration: Number(scope.authority_generation) + 1,
          };
        },
      });
      return { available: true };
    },
    register(input: { app: Hono; upgradeWebSocket: UpgradeWebSocket }): void {
      if (registered || closing) throw new Error("Collaboration routes are already registered or shutting down");
      registered = true;
      input.app.route("/", createCollaborationRoutes({
        runtimeId: options.config.runtimeId,
        verifier,
        authority,
        repository,
        chatScope,
        chatAdapter,
        discussionAdapter,
        ...(chatExecutionAdapter ? { chatExecutionAdapter } : {}),
        ...(terminalAdapter ? { terminalAdapter } : {}),
        ...(terminalDispatcher ? { terminalDispatcher } : {}),
        ...(projectLifecycle ? { projectLifecycle } : {}),
        ...(projectScope ? { projectScope } : {}),
        ...(projectSharing ? { projectSharing } : {}),
        resolveParticipant,
        resolveInvitationIdentifier,
        onScopeCommitted: (scopeId) => eventRegistry.broadcastScope(scopeId),
        onRevoked: (scopeId, actorId) => {
          eventRegistry.notifyRevoked(scopeId, actorId);
          terminalControl?.invalidateActor(scopeId, actorId);
          terminalEventRegistry?.notifyRevoked(scopeId, actorId);
        },
        onRoleChanged: (scopeId, actorId, role) => {
          if (role === "viewer") terminalControl?.invalidateActor(scopeId, actorId);
          void terminalEventRegistry?.publishState(scopeId);
        },
      }));
      registerCollaborationEventWebSocketRoute({
        app: input.app,
        upgradeWebSocket: input.upgradeWebSocket,
        verifier,
        authority,
        registry: eventRegistry,
      });
      if (terminalAdapter && terminalDispatcher && terminalControl && terminalEventRegistry) {
        registerCollaborationTerminalWebSocketRoute({
          app: input.app,
          upgradeWebSocket: input.upgradeWebSocket,
          verifier,
          authority,
          dispatcher: terminalDispatcher,
          registry: terminalEventRegistry,
          control: terminalControl,
        });
      }
    },
    /**
     * Synchronous fence for a startup fallback that cannot wait for a full
     * drain: refuse new registrations and work, stop every timer and detach
     * adapters/registries so nothing dispatches against dependencies the
     * caller is about to destroy. Effective and idempotent even when
     * shutdown() has already started and is still awaiting a drain: every
     * detach below is safe to repeat, so a timed-out shutdown cannot leave a
     * registry or adapter attached. Async drains are started best-effort.
     */
    fence(): void {
      closing = true;
      if (cleanupTimer) clearInterval(cleanupTimer);
      const drainingSharedAi = sharedAiRuntime;
      sharedAiRuntime = undefined;
      chatExecutionAdapter = undefined;
      eventRegistry.shutdown();
      terminalEventRegistry?.shutdown();
      terminalEventRegistry = undefined;
      terminalControl?.close();
      terminalControl = undefined;
      terminalDispatcher = undefined;
      terminalAdapter = undefined;
      const drainingTransitions = projectTransitionCoordinator;
      projectTransitionCoordinator = undefined;
      projectSharing = undefined;
      participantResolver?.shutdown();
      verifier.shutdown();
      for (const [name, drain] of [
        ["shared AI", () => drainingSharedAi?.shutdown()],
        ["project transitions", () => drainingTransitions?.shutdown()],
        ["directory outbox", () => outbox.shutdown()],
      ] as const) {
        void Promise.resolve().then(drain).catch((error: unknown) => {
          console.warn(`[collaboration] fenced ${name} drain failed`, error instanceof Error ? error.name : "UnknownError");
        });
      }
    },
    async shutdown(): Promise<void> {
      if (closing) return;
      closing = true;
      if (cleanupTimer) clearInterval(cleanupTimer);
      await sharedAiRuntime?.shutdown();
      sharedAiRuntime = undefined;
      chatExecutionAdapter = undefined;
      eventRegistry.shutdown();
      terminalEventRegistry?.shutdown();
      terminalEventRegistry = undefined;
      terminalControl?.close();
      terminalControl = undefined;
      terminalDispatcher = undefined;
      terminalAdapter = undefined;
      await projectTransitionCoordinator?.shutdown();
      projectTransitionCoordinator = undefined;
      projectSharing = undefined;
      await outbox.shutdown();
      participantResolver?.shutdown();
      verifier.shutdown();
    },
  };
}

async function cleanupExpiredArtifacts(
  db: Kysely<OwnerCollaborationDatabase>,
  now: Date,
): Promise<void> {
  const cutoff = now.toISOString();
  await db.deleteFrom("collaboration_exports").where("id", "in", (query) => query
    .selectFrom("collaboration_exports").select("id")
    .where("expires_at", "<=", cutoff).orderBy("expires_at", "asc")
    .limit(ARTIFACT_CLEANUP_BATCH_SIZE)).execute();
  await sql`
    DELETE FROM collaboration_operations
    WHERE (scope_id, actor_id, client_request_id, operation_kind) IN (
      SELECT scope_id, actor_id, client_request_id, operation_kind
      FROM collaboration_operations
      WHERE expires_at <= ${cutoff}
        AND status IN ('completed', 'failed')
      ORDER BY expires_at ASC
      LIMIT ${ARTIFACT_CLEANUP_BATCH_SIZE}
    )
  `.execute(db);
}

export type GatewayCollaborationRuntime = Awaited<ReturnType<typeof createGatewayCollaboration>>;
