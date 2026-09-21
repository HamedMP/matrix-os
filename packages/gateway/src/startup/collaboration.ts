/** Build the owner-backed collaboration runtime after Chat and canvas bootstrap. */
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Hono } from "hono";
import type { createNodeWebSocket } from "@hono/node-ws";
import { sql, type Kysely } from "kysely";
import type { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import type { AppRegistry } from "../app-db-registry.js";
import { normalizeAppStorageSlug } from "../app-db-types.js";
import { resolveAppBySlug } from "../app-runtime/app-index.js";
import type { CanonicalProviderSnapshotReader } from "../ai-providers/provider-settings-coordinators.js";
import type { CanvasRepository } from "../canvas/repository.js";
import type { ChatExecutionRootResolver } from "../chat/execution-root.js";
import type { ChatRepository } from "../chat/repository.js";
import { createAppInstanceAdapter } from "../collaboration/app-instance-adapter.js";
import { appRegistryIncarnation } from "../collaboration/app-incarnation.js";
import { createOwnerAppIncarnationResolver } from "../collaboration/owner-app-incarnation.js";
import { createGatewayProjectInventorySource } from "../collaboration/project-inventory-source.js";
import { createProjectChatRootInventory } from "../collaboration/project-chat-root-inventory.js";
import { createProjectGitDriver } from "../collaboration/project-git-operations.js";
import { createOwnerResourceDriver } from "../collaboration/owner-resource-driver.js";
import { createCanonicalTerminalCollaborationBridge } from "../collaboration/canonical-terminal-bridge.js";
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
    onPartialRuntime: (runtime) => {
      const terminalBridge = createCanonicalTerminalCollaborationBridge({
        db: ownerChatRepository.kysely,
        ownerId: collaborationConfig.ownerId ?? "",
        runtime: terminalWorkspaceRuntime,
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
      const ownerAppRegistry = appRegistry;
      const registeredApp = async (appId: string) => {
        const record = await ownerAppRegistry.get(appId);
        return record?.slug === appId ? record : null;
      };
      const resourceDriver = createOwnerResourceDriver({
        homePath,
        listOwnedProjectIds: async (ownerId) => {
          const { projects } = await codingAgentProjectManager.listManagedProjects({
            visibility: "all", ownerScope: { type: "user", id: ownerId },
          });
          return projects.map((project) => project.id);
        },
        resolveProjectWorkingDirectory: async (ownerId, projectId) => {
          const result = await codingAgentProjectManager.getProjectById(
            { type: "user", id: ownerId }, projectId,
          );
          if (!result.ok) return null;
          return codingAgentProjectManager.resolveProjectWorkingDirectory(result.project);
        },
        resolveAppAssetRoot: async (_ownerId, _projectId, appId) => {
          if (!await registeredApp(appId)) return null;
          const resolved = await resolveAppBySlug(join(homePath, "apps"), appId);
          return resolved.ok ? resolved.entry.appDir : null;
        },
      });
      try {
        runtime.enableSharedResources({
          driver: resourceDriver,
          resolveAppIncarnation: createOwnerAppIncarnationResolver(collaborationConfig.ownerId, registeredApp),
          appsFactory: ({ db, authority, catalog, onCommitted }) => {
            const bridge = createScopedAppBridge({
              resolveApp: async (appId) => {
                const record = await registeredApp(appId);
                return record ? { storageSchema: normalizeAppStorageSlug(record.slug), tables: Object.keys(record.tables) } : null;
              },
            });
            return createAppInstanceAdapter({
              db, authority, bridge, catalog, onCommitted,
              apps: {
                resolve: async (projectId, appId) => {
                  const record = await registeredApp(appId);
                  return record ? {
                    projectId, appId, bridgeAppId: normalizeAppStorageSlug(record.slug),
                    collaborationMode: "scoped" as const,
                    incarnation: appRegistryIncarnation(record),
                  } : null;
                },
              },
            });
          },
        });
      } catch (error: unknown) {
        resourceDriver.close();
        throw error;
      }
      const inventorySource = createGatewayProjectInventorySource({
        homePath,
        gitSetup: { get: projectGitDriver.getGitSetup },
        chatRoots: createProjectChatRootInventory({
          db: ownerChatRepository.kysely,
          executionRoots: ownerChatExecutionRoots,
        }),
        projects: {
          get: async (ownerId, projectId) => {
            const result = await codingAgentProjectManager.getProjectById(
              { type: "user", id: ownerId },
              projectId,
            );
            return result.ok ? {
              id: result.project.id,
              ownerId,
              rootPath: result.project.localPath,
              updatedAt: result.project.updatedAt,
            } : null;
          },
        },
        chats: {
          list: async (ownerId, projectId) => chatRepository.kysely.selectFrom("chats")
            .select(["id", "revision"])
            .where("owner_type", "=", "personal")
            .where("owner_id", "=", ownerId)
            .where("project_id", "=", projectId)
            .orderBy("id", "asc")
            .limit(100_001)
            .execute(),
        },
        canvases: {
          getProjectCanvas: async (ownerId, projectId) => {
            const rows = await canvasRepository.kysely.selectFrom("canvas_documents")
              .select(["id", "revision", "nodes"])
              .where("owner_scope", "=", "personal")
              .where("owner_id", "=", ownerId)
              .where("scope_type", "=", "project")
              .where("deleted_at", "is", null)
              .where(sql<boolean>`scope_ref ->> 'projectId' = ${projectId}`)
              .limit(2)
              .execute();
            if (rows.length > 1) throw new Error("ProjectCanvasConflict");
            return rows[0] ?? null;
          },
        },
        apps: {
          get: async (appId) => {
            const app = await appRegistry.get(appId);
            return app ? { id: app.slug, collaborationMode: "scoped" as const, incarnation: appRegistryIncarnation(app) } : null;
          },
        },
        sessions: {
          list: () => terminalWorkspaceRuntime.listWorkspaces(),
        },
      });
      runtime.enableProjectGit({ driver: projectGitDriver, source: inventorySource });
      return runtime.enableSharedProject({ homePath, inventorySource });
    } },
  );
  return construction;
}
