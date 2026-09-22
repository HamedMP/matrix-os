/**
 * S12 wiring for owner resources. The gateway entry point is already far past
 * the size this repository allows new behavior in, so the resource driver's
 * construction, its project lookup and its close-on-failure path live here and
 * the entry point only names them.
 */
import { createOwnerResourceDriver } from "./owner-resource-driver.js";

export type OwnerResourceDriverHandle = ReturnType<typeof createOwnerResourceDriver>;

/** The part of the gateway project manager an owner resource lookup needs. */
export interface OwnerResourceProjectSource<Project> {
  getProjectById(
    ownerScope: { type: "user"; id: string },
    projectId: string,
  ): Promise<{ ok: true; project: Project } | { ok: false; status: number; error: unknown }>;
  resolveProjectWorkingDirectory(project: Project): Promise<string | null>;
}

export interface SharedResourceRuntime {
  enableSharedResources(input: { driver: OwnerResourceDriverHandle }): void;
}

/**
 * Builds the owner resource driver and hands it to the collaboration runtime.
 * The driver owns a sweep timer, so a runtime that refuses it must not leave it
 * running.
 */
export function enableGatewaySharedResources<Project>(input: {
  runtime: SharedResourceRuntime;
  homePath: string;
  projects: OwnerResourceProjectSource<Project>;
  /** Construction seam, like the `now` and `createId` seams elsewhere in this package. */
  createDriver?: typeof createOwnerResourceDriver;
}): OwnerResourceDriverHandle {
  const driver = (input.createDriver ?? createOwnerResourceDriver)({
    homePath: input.homePath,
    resolveProjectWorkingDirectory: async (ownerId, projectId) => {
      const result = await input.projects.getProjectById({ type: "user", id: ownerId }, projectId);
      if (!result.ok) return null;
      return input.projects.resolveProjectWorkingDirectory(result.project);
    },
    // The registered app's asset mapping is resolved by the S12 app bridge.
    resolveAppAssetRoot: async () => null,
  });
  try {
    input.runtime.enableSharedResources({ driver });
  } catch (error: unknown) {
    driver.close();
    throw error;
  }
  return driver;
}
