import { randomUUID } from "node:crypto";
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
import { CollaborationAuthority, CollaborationAuthorizationError } from "./authority.js";
import { CollaborationCapabilityRepository } from "./capability-repository.js";
import { CollaborationCapabilityEvaluator } from "./capability-evaluator.js";
import { drainActiveSharedRunsForCutover, GatewayCollaborationCutover } from "./cutover.js";
import { createCollaborationCutoverRoutes } from "./cutover-route.js";
import { createProjectGitBroker, type ProjectGitDriver, type ProjectGitOwnerIdentity } from "./project-git-broker.js";
import { createProjectAccessReadiness } from "./project-access-readiness.js";
import { createGatewayReadinessProbes } from "./gateway-readiness-probes.js";
import { createOwnerSourceReadinessProbes } from "./account-eligibility.js";
import { CollaborationChatAdapter } from "./chat-adapter.js";
import { CollaborationChatScopeService } from "./chat-scope.js";
import { bootstrapCollaborationDatabase, type OwnerCollaborationDatabase } from "./database.js";
import { CollaborationDirectoryOutbox } from "./directory-outbox.js";
import { CollaborationDiscussionAdapter } from "./discussion-adapter.js";
import { registerCollaborationEventWebSocketRoute } from "./event-websocket-route.js";
import { CollaborationControlClient } from "./control-client.js";
import { DirectReplayCache, DirectTicketVerifier } from "./direct-auth.js";
import { createDirectSessionRoutes } from "./direct-routes.js";
import { DirectSessionService } from "./direct-sessions.js";
import { OwnerRuntimeSessionService } from "./owner-runtime-sessions.js";
import { registerCollaborationDirectWebSocketRoutes } from "./direct-websocket.js";
import { confirmationKeyFromRuntimeIdentity, ensureRuntimeIdentity } from "./runtime-identity.js";
import { CollaborationEventRegistry } from "./events.js";
import { CollaborationParticipantResolver } from "./participant-resolver.js";
import {
  createOrganizationPrecondition,
  type OrganizationMembershipSource,
  type OrganizationPrecondition,
} from "./organization-precondition.js";
import { OrganizationMembershipClient } from "./organization-membership-client.js";
import { CollaborationRepository } from "./repository.js";
import { CollaborationResourceCatalog } from "./resource-catalog.js";
import { StandaloneResourceScopeService } from "./standalone-resource-scope.js";
import type { AppInstanceAdapter } from "./app-instance-adapter.js";
import type { CollaborationResourceDriver, CollaborationResourceServices } from "./resource-routes.js";
import { createCollaborationUploadStager } from "./upload-stages.js";
import { createCollaborationRoutes } from "./routes.js";
import { createSharedAiRuntime } from "./shared-ai-runtime.js";
import type { CanonicalProviderSnapshotReader } from "../ai-providers/provider-settings-coordinators.js";
import { OwnerAccountEligibility } from "./account-eligibility.js";
import {
  CollaborationExecutionPolicyRepository,
  organizationAiSubmissionFromMembershipClient,
  type OrganizationAiSubmissionSource,
} from "./execution-policy.js";
import { CollaborationRunBindingRepository } from "./run-account-binding.js";
import { SharedRunOwnerSource } from "./shared-run-owner-source.js";
import type { CollaborationChatExecutionAdapter } from "./chat-execution-adapter.js";
import { CollaborationTerminalAdapter } from "./terminal-adapter.js";
import { TerminalControlCoordinator } from "./terminal-control.js";
import { CollaborationRevocationEnforcer } from "./revocation-enforcer.js";
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
  resolveInvitationIdentifier?(identifier: string, organizationId: string): Promise<{ actorId: string; displayName: string }>;
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
  /**
   * S08: the owner's Provider V3 snapshot reader. When present, execution
   * policies, run bindings and the shared-run owner source are constructed and
   * the execution-policy routes serve; without it they report unavailable.
   */
  providerSnapshotReader?: CanonicalProviderSnapshotReader;
  /** S08: organization `collaboration.aiSubmission` projection; absent reads as owner-only. */
  organizationAiSubmission?: OrganizationAiSubmissionSource;
}) {
  await bootstrapCollaborationDatabase(options.db);
  await cleanupExpiredArtifacts(options.db, new Date());
  const repository = new CollaborationRepository(options.db, { chatRepository: options.chatRepository });
  const cutoverGuard = new GatewayCollaborationCutover(options.db);
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
    ?? ((identifier: string, organizationId: string) => participantResolver!.resolveInvitationIdentifier(identifier, organizationId));
  const organizationMembershipSource = options.organizationMembershipSource
    ?? (options.organizationPrecondition ? undefined : createDefaultMembershipSource(options.config));
  const organizationPrecondition = options.organizationPrecondition
    ?? createOrganizationPrecondition(organizationMembershipSource ? { source: organizationMembershipSource } : {});
  // S04: whole-project preset grants are the V1 membership; the authority resolves them at registration time.
  const capabilities = new CollaborationCapabilityRepository(options.db, { now: () => new Date(), createId: randomUUID });
  const authority = new CollaborationAuthority(repository, { organizationPrecondition, capabilities });
  // S08: one owner-selected source per execution scope, resolved at construction.
  const eligibility = options.providerSnapshotReader
    ? new OwnerAccountEligibility({ snapshots: { getSnapshotV3: () => options.providerSnapshotReader!.getSnapshot() } })
    : undefined;
  // The organization's AI-submission enablement comes from the same fixed-deadline
  // membership evidence (S03 seam) unless a caller injects its own source.
  const organizationAiSubmission = options.organizationAiSubmission
    ?? (organizationMembershipSource instanceof OrganizationMembershipClient
      ? organizationAiSubmissionFromMembershipClient(organizationMembershipSource)
      : undefined);
  const executionPolicies = eligibility
    ? new CollaborationExecutionPolicyRepository(options.db, {
      eligibility,
      ...(organizationAiSubmission ? { organizationAiSubmission } : {}),
    })
    : undefined;
  const runBindings = eligibility && executionPolicies
    ? new CollaborationRunBindingRepository(options.db, { policies: executionPolicies, eligibility })
    : undefined;
  const ownerSource = eligibility && executionPolicies
    ? new SharedRunOwnerSource({ policies: executionPolicies, eligibility, ...(runBindings ? { bindings: runBindings } : {}) })
    : undefined;
  const verifier = new CollaborationActorProofVerifier({
    runtimeId: options.config.runtimeId,
    keys: options.config.proofKeys,
    authority,
  });
  // S05: direct transport. The platform relay signs nothing on this path; the
  // home verifies tickets against the platform keys learned at registration,
  // and holds every session. Without registered keys or client origins the
  // direct routes fail closed while the rest keeps serving.
  const runtimeIdentity = await ensureRuntimeIdentity(options.db);
  const confirmationSecret = confirmationKeyFromRuntimeIdentity(runtimeIdentity, options.config.runtimeId);
  let controlClient: CollaborationControlClient | undefined;
  const directVerifier = new DirectTicketVerifier({
    runtimeId: options.config.runtimeId,
    platformKeys: () => controlClient?.platformKeys() ?? [],
    // Fail closed: no registration or a stale control snapshot denies every ticket exchange.
    controlFresh: () => controlClient?.controlFresh() ?? false,
    allowedClientOrigins: options.config.clientOrigins,
    replay: new DirectReplayCache(),
  });
  // S07 / T039: lease loss releases terminal control, stops bound sandbox runtimes and refuses input.
  let revocationEnforcer: CollaborationRevocationEnforcer | undefined;
  const directSessions = new DirectSessionService({
    verifier: directVerifier,
    authority,
    repository,
    onAdmitted: (session) => revocationEnforcer?.admit(session.scopeId, session.actorId),
    // A pushed denial closes legacy event/terminal sockets for that actor at once; direct sockets subscribe themselves.
    onEnded: (session, reason) => {
      if (reason !== "revoked" && reason !== "denied") return;
      eventRegistry.notifyRevoked(session.scopeId, session.actorId);
      terminalControl?.invalidateActor(session.scopeId, session.actorId);
      terminalEventRegistry?.notifyRevoked(session.scopeId, session.actorId);
    },
    startTimers: options.startTimers !== false,
  });
  const ownerRuntimeSessions = options.config.ownerId
    ? new OwnerRuntimeSessionService({
        verifier: directVerifier, ownerId: options.config.ownerId,
        runtimeId: options.config.runtimeId, organizationPrecondition,
      })
    : undefined;
  // S07 / T039: lease loss also releases terminal control, stops bound sandbox runtimes and refuses input.
  directSessions.subscribeEnded((session, reason) => revocationEnforcer?.onSessionEnded(session, reason));
  if (options.config.ownerId && options.config.relayHandle) {
    controlClient = new CollaborationControlClient({
      platformBaseUrl: options.config.platformBaseUrl,
      runtimeId: options.config.runtimeId,
      ownerId: options.config.ownerId,
      relayHandle: options.config.relayHandle,
      serviceToken: options.config.serviceToken,
      identity: { keyId: runtimeIdentity.keyId, publicKey: runtimeIdentity.publicKey },
      sessions: directSessions,
      ...(options.outboxFetch ? { fetchImpl: options.outboxFetch } : {}),
      startTimers: options.startTimers !== false,
    });
  } else {
    console.warn("[collaboration] owner identity or relay handle missing: the home never registers for direct transport");
  }
  const chatScope = new CollaborationChatScopeService(options.db, {
    runtimeId: options.config.runtimeId,
    preflightSecret: confirmationSecret,
  });
  const projectTransitions = createProjectTransitionJournal({ db: options.db });
  const projectFence = createProjectFence({ db: options.db, transitions: projectTransitions });
  const projectLifecycle = options.projectLifecycleDrivers
    ? createCollaborationProjectLifecycle({ db: options.db, ...options.projectLifecycleDrivers })
    : undefined;
  if (projectLifecycle) await projectLifecycle.recoverPending();
  const projectScope = options.projectSource ? new CollaborationProjectScopeService(options.db, {
    runtimeId: options.config.runtimeId,
    preflightSecret: confirmationSecret,
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
  let sharedAiOrchestrator: CanonicalChatOrchestrator | undefined;
  let terminalAdapter: CollaborationTerminalAdapter | undefined;
  let terminalControl: TerminalControlCoordinator | undefined;
  let terminalDispatcher: CollaborationTerminalDispatcher | undefined;
  let terminalEventRegistry: CollaborationTerminalEventRegistry | undefined;
  let projectSharing: ProjectSharingService | undefined;
  let projectTransitionCoordinator: ReturnType<typeof createProjectTransitionCoordinator> | undefined;
  let projectGit: ReturnType<typeof createProjectGitBroker> | undefined;
  let projectReadiness: ReturnType<typeof createProjectAccessReadiness> | undefined;
  let projectInventorySource: Pick<ProjectInventoryResourceSource, "listChats" | "getGitSetup"> | undefined;
  let resourceServices: CollaborationResourceServices | undefined;
  let standaloneScope: StandaloneResourceScopeService | undefined;
  let ownerResourceDriver: (CollaborationResourceDriver & { close?(): void }) | undefined;
  function closeResourceServices(): void {
    resourceServices?.uploads?.close();
    ownerResourceDriver?.close?.();
    resourceServices = undefined;
    standaloneScope = undefined;
    ownerResourceDriver = undefined;
  }

  return {
    repository,
    capabilities,
    executionPolicies,
    runBindings,
    ownerSource,
    get projectGit() { return projectGit; },
    get projectReadiness() { return projectReadiness; },
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
    directSessions,
    ownerRuntimeSessions,
    directVerifier,
    controlClient,
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
    enableProjectGit(input: {
      driver: ProjectGitDriver & {
        resolveOwnerIdentity(input: { ownerId: string; projectId: string }): Promise<ProjectGitOwnerIdentity>;
      };
      source: Pick<ProjectInventoryResourceSource, "listChats" | "getGitSetup">;
    }): void {
      if (registered || closing || projectGit || projectReadiness) {
        throw new Error("Project Git must be initialized exactly once before route registration");
      }
      const evaluator = new CollaborationCapabilityEvaluator({
        db: options.db, grants: capabilities, organizationPrecondition,
      });
      projectGit = createProjectGitBroker({
        db: options.db,
        driver: input.driver,
        resolveOwnerIdentity: input.driver.resolveOwnerIdentity,
        authorize: async ({ scopeId, actorId, action }) => {
          const context = await authority.authorize({ scopeId, actorId, action: "read" });
          if (context.resourceKind !== "project" || context.scopeId !== context.membershipScopeId) {
            throw new CollaborationAuthorizationError("not_found", "Project scope is unavailable");
          }
          if (action !== "read") await evaluator.requireAction({ scopeId, actorId, action });
          return { ownerId: context.ownerId, projectId: context.resourceId };
        },
      });
      projectReadiness = createProjectAccessReadiness({ repository, source: input.source });
      projectInventorySource = input.source;
    },
    enableSharedResources(input: {
      driver: CollaborationResourceDriver & { close?(): void };
      resolveAppIncarnation?: CollaborationResourceServices["resolveAppIncarnation"];
      appsFactory?: (dependencies: {
        db: Kysely<OwnerCollaborationDatabase>;
        authority: CollaborationAuthority;
        catalog: CollaborationResourceCatalog;
        onCommitted(scopeId: string): Promise<void>;
      }) => AppInstanceAdapter;
    }): void {
      if (registered || closing || resourceServices) {
        throw new Error("Shared resources must be initialized exactly once before route registration");
      }
      const catalog = new CollaborationResourceCatalog(options.db);
      const onCommitted = async (scopeId: string) => { eventRegistry.broadcastScope(scopeId); };
      const uploads = createCollaborationUploadStager({ db: options.db, catalog, driver: input.driver, onCommitted });
      try {
        const apps = input.appsFactory?.({ db: options.db, authority, catalog, onCommitted });
        resourceServices = { catalog, driver: input.driver, uploads, ...(apps ? { apps } : {}),
          ...(input.resolveAppIncarnation ? { resolveAppIncarnation: input.resolveAppIncarnation } : {}) };
        standaloneScope = new StandaloneResourceScopeService({ resources: resourceServices,
          runtimeId: options.config.runtimeId, preflightSecret: confirmationSecret });
        ownerResourceDriver = input.driver;
      } catch (error: unknown) {
        uploads.close();
        input.driver.close?.();
        throw error;
      }
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
        ...(ownerSource ? { ownerSource } : {}),
        ...(executionPolicies ? { executionPolicies } : {}),
        ...(input.fundedCredentialProvider ? { fundedCredentialProvider: input.fundedCredentialProvider } : {}),
        ...(input.supervisorSocket ? { supervisorSocket: input.supervisorSocket } : {}),
        ...(input.brokerSocket ? { brokerSocket: input.brokerSocket } : {}),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
      sharedAiOrchestrator = input.orchestrator;
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
        preflightSecret: confirmationSecret,
      });
      terminalControl = new TerminalControlCoordinator({
        startTimer: options.startTimers,
        onChanged: ({ scopeId }) => terminalEventRegistry?.publishState(scopeId),
      });
      revocationEnforcer = new CollaborationRevocationEnforcer({ control: terminalControl });
      terminalDispatcher = new CollaborationTerminalDispatcher({
        authority,
        terminal: terminalAdapter,
        control: terminalControl,
        resolveParticipant,
        revocations: revocationEnforcer,
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
        confirmationSecret,
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
        cutoverGuard,
        runtimeId: options.config.runtimeId,
        verifier,
        directSessions,
        ownerRuntimeSessions,
        authority,
        repository,
        capabilities,
        capabilityEvaluator: new CollaborationCapabilityEvaluator({ db: options.db, grants: capabilities, organizationPrecondition }),
        readinessProbes: createGatewayReadinessProbes({
          repository, chats: options.chatRepository,
          projectSource: () => projectInventorySource,
          sandboxSupported: async (subject) => sharedAiRuntime?.available === true
            ? sharedAiRuntime.sandboxSupported(subject) : false,
          ownerSource: eligibility && executionPolicies
            ? createOwnerSourceReadinessProbes({ policies: executionPolicies, eligibility }) : undefined,
        }),
        chatScope,
        chatAdapter,
        discussionAdapter,
        ...(chatExecutionAdapter ? { chatExecutionAdapter } : {}),
        ...(terminalAdapter ? { terminalAdapter } : {}),
        ...(terminalDispatcher ? { terminalDispatcher } : {}),
        ...(projectLifecycle ? { projectLifecycle } : {}),
        ...(projectScope ? { projectScope } : {}),
        ...(projectSharing ? { projectSharing } : {}),
        ...(projectGit ? { projectGit } : {}),
        ...(projectReadiness ? { projectReadiness } : {}),
        resolveParticipant,
        resolveInvitationIdentifier,
        ...(executionPolicies ? { executionPolicies } : {}),
        ...(resourceServices ? { resources: resourceServices } : {}),
        ...(standaloneScope ? { standaloneScope } : {}),
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
      input.app.route("/", createCollaborationCutoverRoutes({
        ownerId: options.config.ownerId ?? "",
        runtimeId: options.config.runtimeId,
        platformKeys: () => controlClient?.platformKeys() ?? [],
        controlFresh: () => controlClient?.controlFresh() ?? false,
        cutover: cutoverGuard,
        drainRuns: (key) => drainActiveSharedRunsForCutover({
          db: options.db, scopeId: key.scopeId, ownerId: key.ownerId,
          orchestrator: {
            cancelSharedRun: async (...args) => {
              if (!sharedAiOrchestrator) throw new Error("Shared execution orchestrator unavailable");
              await sharedAiOrchestrator.cancelSharedRun(...args);
            },
          },
        }),
      }));
      registerCollaborationEventWebSocketRoute({
        app: input.app,
        upgradeWebSocket: input.upgradeWebSocket,
        verifier,
        authority,
        registry: eventRegistry,
      });
      input.app.route("/", createDirectSessionRoutes({ sessions: directSessions, ownerRuntimeSessions }));
      registerCollaborationDirectWebSocketRoutes({
        app: input.app,
        upgradeWebSocket: input.upgradeWebSocket,
        verifier: directVerifier,
        sessions: directSessions,
        authority,
        events: eventRegistry,
        ...(terminalDispatcher && terminalEventRegistry && terminalControl
          ? { terminal: { dispatcher: terminalDispatcher, registry: terminalEventRegistry, control: terminalControl } }
          : {}),
      });
      void controlClient?.start().catch((error: unknown) => {
        console.warn("[collaboration] control client start failed", error instanceof Error ? error.name : "UnknownError");
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
      closeResourceServices();
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
      void ownerRuntimeSessions?.shutdown();
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
      closeResourceServices();
      await controlClient?.shutdown();
      await directSessions.shutdown();
      await ownerRuntimeSessions?.shutdown();
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

/**
 * S03: the platform's Clerk membership projection is the only membership
 * source. Any configuration problem leaves no source registered, which the
 * S20 precondition treats as "deny everything".
 */
function createDefaultMembershipSource(config: GatewayCollaborationConfig): OrganizationMembershipSource | undefined {
  try {
    return new OrganizationMembershipClient({
      platformBaseUrl: config.platformBaseUrl,
      runtimeId: config.runtimeId,
      serviceToken: config.serviceToken,
    });
  } catch (error: unknown) {
    console.warn("[collaboration] organization membership source unavailable", error instanceof Error ? error.name : "UnknownError");
    return undefined;
  }
}

export type GatewayCollaborationRuntime = Awaited<ReturnType<typeof createGatewayCollaboration>>;
