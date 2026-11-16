import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { ProjectAgentConfigFileSchema, ProjectIdSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { GalleryError, GalleryFileError, isFsError, pinDirectory } from "./app-gallery/pinned-directory.js";
import { projectAgentConfigFileExists } from "./project-agent-context.js";
import { createProjectRegistry, PROJECT_SLUG_REGEX } from "./project-registry.js";
import type { createProjectManager } from "./project-manager.js";
import { withProjectLock, type OwnerScope } from "./state-ops.js";

export const ProjectMetadataPatchSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  description: z.string().trim().max(1_000).optional(),
  pinned: z.boolean().optional(),
}).strict().refine(value => Object.values(value).some(field => field !== undefined));
export const ProjectMetadataSlugSchema = z.string().regex(PROJECT_SLUG_REGEX);
export const ProjectFilesLocationQuerySchema = z.object({
  projectId: ProjectIdSchema.optional(),
  file: ProjectAgentConfigFileSchema.optional(),
}).refine(query => query.file === undefined || query.projectId !== undefined);

const unavailableLocation = (status: 404 | 500 | 503) => ({
  ok: false as const,
  status,
  error: { code: status === 404 ? "not_found" : "unavailable", message: "Project file location is unavailable" },
});

export function createProjectMetadataService(options: {
  homePath: string;
  projectManager: Pick<ReturnType<typeof createProjectManager>, "getProject">;
}) {
  const registry = createProjectRegistry({ homePath: options.homePath });
  return async (slug: string, ownerScope: OwnerScope, rawPatch: unknown, expectedProjectId?: string) => {
    const parsed = ProjectMetadataPatchSchema.safeParse(rawPatch);
    if (!parsed.success || !ProjectMetadataSlugSchema.safeParse(slug).success) {
      return { ok: false as const, status: 400, error: { code: "invalid_request", message: "Project update is invalid" } };
    }
    return withProjectLock(slug, async () => {
      try {
        const current = await options.projectManager.getProject(slug, ownerScope);
        if (!current.ok) return current;
        if (expectedProjectId !== undefined && current.project.id !== expectedProjectId) {
          return {
            ok: false as const,
            status: 409,
            error: { code: "project_changed", message: "Project changed before update" },
          };
        }
        const project = { ...current.project, ...parsed.data, updatedAt: new Date().toISOString() };
        await registry.writeConfig(slug, project);
        return { ok: true as const, project };
      } catch (error: unknown) {
        console.error("[project-metadata] Update failed:", error instanceof Error ? error.name : "UnknownError");
        return { ok: false as const, status: 500, error: { code: "update_failed", message: "Project could not be updated" } };
      }
    });
  };
}

export function createProjectFilesLocationService(options: {
  homePath: string;
  projectManager: Pick<ReturnType<typeof createProjectManager>, "getProject" | "resolveProjectWorkingDirectory">;
}) {
  return async (slug: string, ownerScope: OwnerScope, query: z.infer<typeof ProjectFilesLocationQuerySchema> = {}) => {
    try {
      const current = await options.projectManager.getProject(slug, ownerScope);
      if (!current.ok) return current;
      if (query.projectId && (ownerScope.type !== "user" || current.project.id !== query.projectId)) {
        return unavailableLocation(404);
      }
      const directory = await options.projectManager.resolveProjectWorkingDirectory(current.project);
      if (!directory) return unavailableLocation(404);
      const path = relative(await realpath(options.homePath), directory);
      if (!path || isAbsolute(path) || path === ".." || path.startsWith("../")) return unavailableLocation(404);
      if (!query.file) return { ok: true as const, path };

      const root = await pinDirectory(directory);
      try {
        const identity = await root.identity();
        if (!await projectAgentConfigFileExists(root, query.file)) return unavailableLocation(404);
        const latest = await options.projectManager.getProject(slug, ownerScope);
        if (!latest.ok || latest.project.id !== query.projectId
          || await options.projectManager.resolveProjectWorkingDirectory(latest.project) !== directory) {
          return unavailableLocation(404);
        }
        const currentDirectory = await lstat(directory);
        if (!currentDirectory.isDirectory() || currentDirectory.dev !== identity.dev
          || currentDirectory.ino !== identity.ino) return unavailableLocation(404);
        return { ok: true as const, path: `${path}/${query.file}` };
      } finally {
        await root.close();
      }
    } catch (error: unknown) {
      if (error instanceof GalleryFileError || ["ENOENT", "ENOTDIR", "ELOOP"].some(code => isFsError(error, code))) {
        return unavailableLocation(404);
      }
      if (error instanceof GalleryError) return unavailableLocation(503);
      console.error("[project-files] Resolve failed:", error instanceof Error ? error.name : "UnknownError");
      return unavailableLocation(500);
    }
  };
}
