/** Build the owner-backed collaboration runtime after Chat and canvas bootstrap. */
import { join } from "node:path";
import type { Hono } from "hono";
import type { createNodeWebSocket } from "@hono/node-ws";
import { sql, type Kysely } from "kysely";
import type { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import type { AppRegistry } from "../app-db-registry.js";
import type { CanonicalProviderSnapshotReader } from "../ai-providers/provider-settings-coordinators.js";
import type { CanvasRepository } from "../canvas/repository.js";
import type { ChatExecutionRootResolver } from "../chat/execution-root.js";
import type { ChatRepository } from "../chat/repository.js";
import { enableOwnerCollaborationSurfaces } from "../collaboration/owner-runtime-surfaces.js";
import { createProjectGitDriver } from "../collaboration/project-git-operations.js";
import { createOwnerResourceDriver } from "../collaboration/owner-resource-driver.js";
import { createScopedAppBridge } from "../collaboration/scoped-app-bridge.js";
import { registerFailClosedCollaborationRoutes } from "../collaboration/fail-closed.js";
import {
  constructGatewayCollaborationOrFailClosed,
  createGatewayCollaboration,
  type GatewayCollaborationConfig,
  type GatewayCollaborationConfigurationFailure,
  type GatewayCollaborationRuntime,
} from "../collaboration/wiring.js";
import type { createProjectManager } from "../project-manager.js";

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
}

export async function constructOwnerCollaboration(options: OwnerCollaborationStartupOptions) {
  const {
    homePath, chatRepository, appRegistry, canvasRepository, collaborationConfig,
    providerSnapshotReader, codingAgentProjectManager, ownerChatExecutionRoots,
    terminalWorkspaceRuntime,
  } = options;
  const ownerChatRepository = chatRepository;
  const projectGitDriver = createProjectGitDriver({
    resolveProjectRoot: async ({ ownerId, projectId }) => {
      const root = await ownerChatExecutionRoots.resolve(
        { type: "personal", ownerId }, { kind: "project", projectId },
      );
      return root.primaryWorkspaceRoot;
    },
  });
  const construction = await constructGatewayCollaborationOrFailClosed(
    () => createGatewayCollaboration({
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
  }),
    {
    // The shared resources, their app binding and the project inventory belong
    // to the collaboration package's own composition. Calling it here instead
    // of keeping a copy of that body is what stops the resource driver's
    // app-asset and app-incarnation wiring from drifting out of this startup
    // module the next time either side moves.
    onPartialRuntime: (runtime) => enableOwnerCollaborationSurfaces(runtime, {
      homePath,
      ownerId: collaborationConfig.ownerId,
      appRegistry,
      canvasRepository,
      chatRepository: ownerChatRepository,
      chatExecutionRoots: ownerChatExecutionRoots,
      projectManager: codingAgentProjectManager,
      projectGitDriver,
      terminalWorkspaces: terminalWorkspaceRuntime,
    }) },
  );
  return construction;
}
