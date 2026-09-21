/**
 * S12 wiring for owner resources. The gateway entry point is already far past
 * the size this repository allows new behavior in, so the resource driver's
 * construction, its project and app lookups, the shared app instance adapter
 * and the close-on-failure path live here and the entry point only names them.
 */
import { join } from "node:path";
import type { Kysely } from "kysely";
import type { AppRegistry } from "../app-db-registry.js";
import { normalizeAppStorageSlug } from "../app-db-types.js";
import { resolveAppBySlug } from "../app-runtime/app-index.js";
import { appRegistryIncarnation } from "./app-incarnation.js";
import { createAppInstanceAdapter, type AppInstanceAdapter } from "./app-instance-adapter.js";
import type { CollaborationAuthority } from "./authority.js";
import type { OwnerCollaborationDatabase } from "./database.js";
import { createOwnerResourceDriver } from "./owner-resource-driver.js";
import type { CollaborationResourceCatalog } from "./resource-catalog.js";
import { createScopedAppBridge } from "./scoped-app-bridge.js";

export type OwnerResourceDriverHandle = ReturnType<typeof createOwnerResourceDriver>;

/** The part of the gateway project manager an owner resource lookup needs. */
export interface OwnerResourceProjectSource<Project> {
  listManagedProjects(input: {
    visibility: "all";
    ownerScope: { type: "user"; id: string };
  }): Promise<{ projects: readonly { id: string }[] }>;
  getProjectById(
    ownerScope: { type: "user"; id: string },
    projectId: string,
  ): Promise<{ ok: true; project: Project } | { ok: false; status: number; error: unknown }>;
  resolveProjectWorkingDirectory(project: Project): Promise<string | null>;
}

/** The part of the owner app registry a shared app instance is derived from. */
export type OwnerAppRegistrySource = Pick<AppRegistry, "get">;

export interface SharedResourceRuntime {
  enableSharedResources(input: {
    driver: OwnerResourceDriverHandle;
    appsFactory?: (dependencies: {
      db: Kysely<OwnerCollaborationDatabase>;
      authority: CollaborationAuthority;
      catalog: CollaborationResourceCatalog;
      onCommitted(scopeId: string): Promise<void>;
    }) => AppInstanceAdapter;
  }): void;
}

/**
 * Builds the owner resource driver and the shared app instance adapter, then
 * hands both to the collaboration runtime. The driver owns a sweep timer, so a
 * runtime that refuses it must not leave it running.
 */
export function enableGatewaySharedResources<Project>(input: {
  runtime: SharedResourceRuntime;
  homePath: string;
  projects: OwnerResourceProjectSource<Project>;
  /**
   * The owner's app registry. Shared apps are bound to it, so a missing
   * registry is a misconfiguration the gateway must refuse rather than a
   * runtime without app binding.
   */
  apps: OwnerAppRegistrySource | null;
  /** Construction seam, like the `now` and `createId` seams elsewhere in this package. */
  createDriver?: typeof createOwnerResourceDriver;
}): OwnerResourceDriverHandle {
  const appRegistry = input.apps;
  if (!appRegistry) throw new Error("Owner app registry is unavailable");
  // The registry is keyed by slug; anything else is a caller-shaped id that must
  // not reach the owner's app storage.
  const registeredApp = async (appId: string) => {
    const record = await appRegistry.get(appId);
    return record?.slug === appId ? record : null;
  };
  const driver = (input.createDriver ?? createOwnerResourceDriver)({
    homePath: input.homePath,
    listOwnedProjectIds: async (ownerId) => {
      const { projects } = await input.projects.listManagedProjects({
        visibility: "all", ownerScope: { type: "user", id: ownerId },
      });
      return projects.map((project) => project.id);
    },
    resolveProjectWorkingDirectory: async (ownerId, projectId) => {
      const result = await input.projects.getProjectById({ type: "user", id: ownerId }, projectId);
      if (!result.ok) return null;
      return input.projects.resolveProjectWorkingDirectory(result.project);
    },
    resolveAppAssetRoot: async (_ownerId, _projectId, appId) => {
      if (!await registeredApp(appId)) return null;
      const resolved = await resolveAppBySlug(join(input.homePath, "apps"), appId);
      return resolved.ok ? resolved.entry.appDir : null;
    },
  });
  try {
    input.runtime.enableSharedResources({
      driver,
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
    driver.close();
    throw error;
  }
  return driver;
}
