/**
 * Composition of the owner-home collaboration surfaces: the shared resources
 * the resource wiring builds, and the project inventory the Git broker and
 * shared project read from. This lives beside the collaboration runtime rather
 * than in the gateway entry point so the wiring stays reviewable on its own.
 */
import { sql } from "kysely";
import type { AppRegistry } from "../app-db-registry.js";
import type { CanvasRepository } from "../canvas/repository.js";
import type { ChatExecutionRootResolver } from "../chat/execution-root.js";
import type { ChatRepository } from "../chat/repository.js";
import type { createProjectManager } from "../project-manager.js";
import { appRegistryIncarnation } from "./app-incarnation.js";
import { createProjectChatRootInventory } from "./project-chat-root-inventory.js";
import type { createProjectGitDriver } from "./project-git-operations.js";
import { createGatewayProjectInventorySource } from "./project-inventory-source.js";
import { enableGatewaySharedResources } from "./resource-wiring.js";
import type { createGatewayCollaboration } from "./wiring.js";

/** The subset of the collaboration runtime this composition enables. */
export type OwnerCollaborationRuntimeSurfaces = Pick<
  Awaited<ReturnType<typeof createGatewayCollaboration>>,
  "enableSharedResources" | "enableProjectGit" | "enableSharedProject"
>;

type InventoryOptions = Parameters<typeof createGatewayProjectInventorySource>[0];

export interface OwnerCollaborationSurfaceDependencies {
  homePath: string;
  /** The runtime's configured owner; an app identity is resolved for no one else. */
  ownerId: string | undefined;
  appRegistry: AppRegistry | null;
  canvasRepository: CanvasRepository | null;
  chatRepository: ChatRepository;
  chatExecutionRoots: ChatExecutionRootResolver;
  projectManager: ReturnType<typeof createProjectManager>;
  projectGitDriver: ReturnType<typeof createProjectGitDriver>;
  terminalWorkspaces: { listWorkspaces: InventoryOptions["sessions"]["list"] };
}

export async function enableOwnerCollaborationSurfaces(
  runtime: OwnerCollaborationRuntimeSurfaces,
  dependencies: OwnerCollaborationSurfaceDependencies,
): Promise<unknown> {
  const { homePath, chatRepository, chatExecutionRoots, projectManager, projectGitDriver } = dependencies;
  const appRegistry = dependencies.appRegistry;
  const canvasRepository = dependencies.canvasRepository;
  if (!appRegistry) throw new Error("Owner app registry is unavailable");
  if (!canvasRepository) throw new Error("Owner canvas repository is unavailable");
  // The resource driver, its app binding and its close-on-failure path belong to
  // the resource wiring; this composition only names them.
  enableGatewaySharedResources({ runtime, homePath, ownerId: dependencies.ownerId,
    projects: projectManager, apps: appRegistry });
  const inventorySource = createGatewayProjectInventorySource({
    homePath,
    gitSetup: { get: projectGitDriver.getGitSetup },
    chatRoots: createProjectChatRootInventory({
      db: chatRepository.kysely,
      executionRoots: chatExecutionRoots,
    }),
    projects: {
      get: async (ownerId, projectId) => {
        const result = await projectManager.getProjectById({ type: "user", id: ownerId }, projectId);
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
      list: () => dependencies.terminalWorkspaces.listWorkspaces(),
    },
  });
  runtime.enableProjectGit({ driver: projectGitDriver, source: inventorySource });
  return runtime.enableSharedProject({ homePath, inventorySource });
}
