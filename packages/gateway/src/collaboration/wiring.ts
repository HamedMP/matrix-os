import { sql, type Kysely } from "kysely";
import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { ChatRepository } from "../chat/repository.js";
import type { CanonicalChatOrchestrator } from "../chat/orchestrator.js";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import { CollaborationActorProofVerifier } from "./actor-proof.js";
import { CollaborationAuthority } from "./authority.js";
import { CollaborationChatAdapter } from "./chat-adapter.js";
import { CollaborationChatScopeService } from "./chat-scope.js";
import { bootstrapCollaborationDatabase, type OwnerCollaborationDatabase } from "./database.js";
import { CollaborationDirectoryOutbox } from "./directory-outbox.js";
import { registerCollaborationEventWebSocketRoute } from "./event-websocket-route.js";
import { CollaborationEventRegistry } from "./events.js";
import { CollaborationParticipantResolver } from "./participant-resolver.js";
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

const MAX_PROOF_KEYS = 8;
const ARTIFACT_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const ARTIFACT_CLEANUP_BATCH_SIZE = 1_000;
const MACHINE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface GatewayCollaborationConfig {
  runtimeId: string;
  activeKeyId: string;
  proofKeys: Readonly<Record<string, string>>;
  preflightSecret: string;
  platformBaseUrl: string;
  serviceToken: string;
}

export function loadGatewayCollaborationConfig(env: NodeJS.ProcessEnv): GatewayCollaborationConfig | null {
  if (env.MATRIX_COLLABORATION_ENABLED !== "true") return null;
  const configuredRuntimeId = env.MATRIX_RUNTIME_ID?.trim();
  const machineId = env.MATRIX_MACHINE_ID?.trim();
  const runtimeId = configuredRuntimeId
    || (machineId && MACHINE_ID_PATTERN.test(machineId) ? `vps:${machineId.toLowerCase()}` : undefined);
  const activeKeyId = env.MATRIX_COLLABORATION_ACTIVE_KEY_ID?.trim();
  const preflightSecret = env.MATRIX_COLLABORATION_PREFLIGHT_SECRET;
  const platformBaseUrl = env.PLATFORM_INTERNAL_URL?.trim();
  const serviceToken = env.UPGRADE_TOKEN;
  if (!runtimeId || !activeKeyId || !preflightSecret || !platformBaseUrl || !serviceToken) return null;
  let proofKeys: Record<string, string>;
  try {
    const parsed = JSON.parse(env.MATRIX_COLLABORATION_PROOF_KEYS ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    proofKeys = Object.fromEntries(Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ));
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[collaboration] proof key configuration parse failed", error instanceof Error ? error.name : "UnknownError");
    }
    return null;
  }
  const entries = Object.entries(proofKeys);
  if (entries.length < 1 || entries.length > MAX_PROOF_KEYS
    || entries.some(([keyId, key]) => !/^[A-Za-z0-9_.-]{1,80}$/.test(keyId) || Buffer.byteLength(key) < 32)
    || !proofKeys[activeKeyId] || Buffer.byteLength(preflightSecret) < 32 || Buffer.byteLength(serviceToken) < 32) {
    return null;
  }
  return { runtimeId, activeKeyId, proofKeys, preflightSecret, platformBaseUrl, serviceToken };
}

export async function createGatewayCollaboration(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  chatRepository: ChatRepository;
  config: GatewayCollaborationConfig;
  resolveParticipant?(actorId: string): Promise<{ actorId: string; displayName: string }>;
  outboxFetch?: typeof fetch;
  startTimers?: boolean;
}) {
  await bootstrapCollaborationDatabase(options.db);
  await cleanupExpiredArtifacts(options.db, new Date());
  const repository = new CollaborationRepository(options.db, { chatRepository: options.chatRepository });
  const participantResolver = options.resolveParticipant ? undefined : new CollaborationParticipantResolver({
    platformBaseUrl: options.config.platformBaseUrl,
    runtimeId: options.config.runtimeId,
    serviceToken: options.config.serviceToken,
  });
  const resolveParticipant = options.resolveParticipant
    ?? ((actorId: string) => participantResolver!.resolve(actorId));
  const authority = new CollaborationAuthority(repository);
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

  return {
    repository,
    authority,
    verifier,
    eventRegistry,
    chatScope,
    chatAdapter,
    outbox,
    collaborationGuard: chatScope,
    projectTransitions,
    projectFence,
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
        ...(chatExecutionAdapter ? { chatExecutionAdapter } : {}),
        ...(terminalAdapter ? { terminalAdapter } : {}),
        ...(terminalDispatcher ? { terminalDispatcher } : {}),
        resolveParticipant,
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
