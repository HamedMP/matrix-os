/** Build the owner-backed collaboration runtime after Chat and canvas bootstrap. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Hono } from "hono";
import type { createNodeWebSocket } from "@hono/node-ws";
import type { Kysely } from "kysely";
import type { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import type { AppRegistry } from "../app-db-registry.js";
import type { CanonicalProviderSnapshotReader } from "../ai-providers/provider-settings-coordinators.js";
import type { CanvasRepository } from "../canvas/repository.js";
import type { ChatExecutionRootResolver } from "../chat/execution-root.js";
import type { ChatRepository } from "../chat/repository.js";
import { enableOwnerCollaborationSurfaces } from "../collaboration/owner-runtime-surfaces.js";
import { createProjectGitDriver } from "../collaboration/project-git-operations.js";
import { createCanonicalTerminalCollaborationBridge } from "../collaboration/canonical-terminal-bridge.js";
import type { OwnerCollaborationDatabase } from "../collaboration/database.js";
import { CollaborativeAppReadinessRepository } from "../collaboration/collaborative-app-readiness-repository.js";
import { CollaborativeAppShareRepository } from "../collaboration/collaborative-app-share-repository.js";
import { ImmutableCollaborativeBuildStore } from "../app-runtime/build-cache.js";
import { registerFailClosedCollaborationRoutes } from "../collaboration/fail-closed.js";
import {
  constructGatewayCollaborationOrFailClosed,
  createGatewayCollaboration,
  type GatewayCollaborationConfig,
  type GatewayCollaborationConfigurationFailure,
  type GatewayCollaborationRuntime,
} from "../collaboration/wiring.js";
import type { createProjectManager } from "../project-manager.js";

const COLLABORATIVE_BUILD_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const COLLABORATIVE_BUILD_CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const MAX_COLLABORATIVE_BUILD_SNAPSHOTS = 1_000;

export interface CollaborativeAppInfrastructure {
  readiness: CollaborativeAppReadinessRepository;
  shares: CollaborativeAppShareRepository;
  builds: ImmutableCollaborativeBuildStore;
  close(): Promise<void>;
}

/** Repository wrappers borrow the owner pool; only the immutable-build store is owned here. */
export function createCollaborativeAppInfrastructure(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  buildStoreRoot: string;
  startTimers?: boolean;
}): CollaborativeAppInfrastructure {
  const builds = new ImmutableCollaborativeBuildStore({
    rootDir: options.buildStoreRoot,
    maxSnapshots: MAX_COLLABORATIVE_BUILD_SNAPSHOTS,
    retentionMs: COLLABORATIVE_BUILD_RETENTION_MS,
    cleanupIntervalMs: COLLABORATIVE_BUILD_CLEANUP_INTERVAL_MS,
    startTimer: options.startTimers !== false,
    isProtectedBuild: async (buildId) => {
      const readiness = await options.db.selectFrom("collaboration_app_readiness")
        .select("build_id")
        .where("build_id", "=", buildId)
        .where("status", "in", ["checking", "ready"])
        .where("invalidated_at", "is", null)
        .executeTakeFirst();
      if (readiness) return true;
      const binding = await options.db.selectFrom("collaboration_app_bindings")
        .select("build_id")
        .where("build_id", "=", buildId)
        .where("state", "!=", "stopped")
        .executeTakeFirst();
      return Boolean(binding);
    },
  });
  return {
    readiness: new CollaborativeAppReadinessRepository(options.db),
    shares: new CollaborativeAppShareRepository(options.db),
    builds,
    close: () => builds.close(),
  };
}

function ownCollaborativeAppInfrastructure<T extends {
  shutdown(): Promise<void>;
  fence?: () => void;
}>(runtime: T, infrastructure: CollaborativeAppInfrastructure): T & {
  collaborativeApps: CollaborativeAppInfrastructure;
} {
  const shutdown = runtime.shutdown.bind(runtime);
  const fence = runtime.fence?.bind(runtime);
  return Object.assign(runtime, {
    collaborativeApps: infrastructure,
    async shutdown(): Promise<void> {
      try {
        await shutdown();
      } finally {
        await infrastructure.close();
      }
    },
    ...(fence ? {
      fence(): void {
        void infrastructure.close();
        fence();
      },
    } : {}),
  });
}

export interface OwnerCollaborationRouteOptions {
  app: Hono;
  upgradeWebSocket: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"];
  gatewayCollaboration: GatewayCollaborationRuntime | null;
  collaborationFailClosedReason: GatewayCollaborationConfigurationFailure | null;
}

/** Preserve registration order and make the owner-database fallback explicit. */
export function registerOwnerCollaborationRoutes(options: OwnerCollaborationRouteOptions): void {
  const { app, upgradeWebSocket, gatewayCollaboration, collaborationFailClosedReason } = options;
  if (gatewayCollaboration) {
    gatewayCollaboration.register({ app, upgradeWebSocket });
  } else {
    registerFailClosedCollaborationRoutes({
      app,
      upgradeWebSocket,
      reason: collaborationFailClosedReason ?? "owner_database_missing",
    });
  }
}

export async function enableOwnerSharedAi(options: {
  gatewayCollaboration: GatewayCollaborationRuntime | null;
  input: Parameters<GatewayCollaborationRuntime["enableSharedAi"]>[0];
  log?: (message: string) => void;
}): Promise<void> {
  if (!options.gatewayCollaboration) return;
  const sharedAi = await options.gatewayCollaboration.enableSharedAi(options.input);
  (options.log ?? console.log)(`[collaboration] shared AI ${sharedAi.available ? "ready" : "disabled"}`);
}

export interface OwnerCollaborationStartupOptions {
  homePath: string;
  chatRepository: ChatRepository;
  appRegistry: AppRegistry;
  canvasRepository: CanvasRepository;
  collaborationConfig: GatewayCollaborationConfig;
  providerSnapshotReader: CanonicalProviderSnapshotReader;
  codingAgentProjectManager: ReturnType<typeof createProjectManager>;
  ownerChatExecutionRoots: ChatExecutionRootResolver;
  terminalWorkspaceRuntime: TerminalRuntimeSocketClient;
  retireTerminalRoutineSource?: Parameters<typeof createCanonicalTerminalCollaborationBridge>[0]["retireRoutineSource"];
}

export async function constructOwnerCollaboration(options: OwnerCollaborationStartupOptions) {
  const {
    homePath, chatRepository, appRegistry, canvasRepository, collaborationConfig,
    providerSnapshotReader, codingAgentProjectManager, ownerChatExecutionRoots,
    terminalWorkspaceRuntime,
  } = options;
  const ownerChatRepository = chatRepository;
  const collaborativeApps = createCollaborativeAppInfrastructure({
    db: ownerChatRepository.kysely as unknown as Kysely<OwnerCollaborationDatabase>,
    buildStoreRoot: join(homePath, "system", "collaboration", "app-builds"),
  });
  const projectGitDriver = createProjectGitDriver({
    homePath,
    resolveProjectRoot: async ({ ownerId, projectId }) => {
      const root = await ownerChatExecutionRoots.resolve(
        { type: "personal", ownerId }, { kind: "project", projectId },
      );
      return root.primaryWorkspaceRoot;
    },
  });
  const construction = await constructGatewayCollaborationOrFailClosed(
    async () => {
      try {
        const runtime = await createGatewayCollaboration({
          db: ownerChatRepository.kysely as Kysely<any>,
          chatRepository: ownerChatRepository,
          config: collaborationConfig,
          providerSnapshotReader,
          projectSource: {
            getProject: async (ownerId, projectId) => {
              const result = await codingAgentProjectManager.getProjectById(
                { type: "user", id: ownerId },
                projectId,
              );
              if (!result.ok) return null;
              const revision = Date.parse(result.project.updatedAt);
              if (!Number.isSafeInteger(revision) || revision < 0) {
                throw new Error("ProjectRevisionUnavailable");
              }
              return { id: result.project.id, ownerId, revision };
            },
          },
        });
        return ownCollaborativeAppInfrastructure(runtime, collaborativeApps);
      } catch (error: unknown) {
        await collaborativeApps.close();
        throw error;
      }
    },
    {
    // The shared resources, their app binding and the project inventory belong to the
    // collaboration package's own composition, so this delegates rather than keeping a copy —
    // that is what stops the resource driver's app-asset and app-incarnation wiring drifting
    // out of this startup module. The canonical terminal bridge is this layer's own addition
    // and is wired here, before the delegation, because it must exist on the runtime first.
    onPartialRuntime: async (runtime) => {
      // The owner Chat database is the owner collaboration database (same Kysely instance as `db` above).
      const terminalBridge = createCanonicalTerminalCollaborationBridge({
        db: ownerChatRepository.kysely as unknown as Kysely<OwnerCollaborationDatabase>,
        ownerId: collaborationConfig.ownerId ?? "",
        runtime: terminalWorkspaceRuntime,
        retireRoutineSource: options.retireTerminalRoutineSource,
      });
      runtime.enableSharedTerminal({
        registry: terminalBridge.registry,
        runtime: terminalBridge.runtime,
        connectOutput: terminalBridge.connectOutput,
        executionEligibility: {
          profileId: "scope-runtime-terminal-v1",
          profileVersion: 1,
          profileDigest: createHash("sha256").update("matrix-canonical-host-terminal-v1").digest("hex"),
          adapterId: "terminal",
          harnessVersion: "1.0.0",
        },
      });
      const surfaces = await enableOwnerCollaborationSurfaces(runtime, {
        homePath,
        ownerId: collaborationConfig.ownerId,
        appRegistry,
        canvasRepository,
        chatRepository: ownerChatRepository,
        chatExecutionRoots: ownerChatExecutionRoots,
        projectManager: codingAgentProjectManager,
        projectGitDriver,
        terminalWorkspaces: terminalWorkspaceRuntime,
      });
      if (!collaborationConfig.ownerId) throw new Error("Collaborative app owner is unavailable");
      runtime.enableCollaborativeAppReadiness({
        ownerId: collaborationConfig.ownerId,
        homePath,
        appRegistry,
        repository: collaborativeApps.readiness,
        shares: collaborativeApps.shares,
        builds: collaborativeApps.builds,
      });
      return surfaces;
    } },
  );
  return construction;
}
