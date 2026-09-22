import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { z } from "zod/v4";
import { createProjectRegistry, PROJECT_SLUG_REGEX } from "./project-registry.js";
import type { createProjectManager } from "./project-manager.js";
import { withProjectLock, type OwnerScope } from "./state-ops.js";

export const ProjectMetadataPatchSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  description: z.string().trim().max(1_000).optional(),
  pinned: z.boolean().optional(),
}).strict().refine(value => Object.values(value).some(field => field !== undefined));
export const ProjectMetadataSlugSchema = z.string().regex(PROJECT_SLUG_REGEX);

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
  return async (slug: string, ownerScope: OwnerScope) => {
    try {
      const current = await options.projectManager.getProject(slug, ownerScope);
      if (!current.ok) return current;
      const directory = await options.projectManager.resolveProjectWorkingDirectory(current.project);
      if (directory) {
        const path = relative(await realpath(options.homePath), directory);
        if (path && !isAbsolute(path) && path !== ".." && !path.startsWith("../")) return { ok: true as const, path };
      }
      return { ok: false as const, status: 404, error: { code: "not_found", message: "Project folder is unavailable" } };
    } catch (error: unknown) {
      console.error("[project-files] Resolve failed:", error instanceof Error ? error.name : "UnknownError");
      return { ok: false as const, status: 500, error: { code: "unavailable", message: "Project folder is unavailable" } };
    }
  };
}
