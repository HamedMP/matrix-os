import { z } from "zod/v4";
import { createProjectManager, PROJECT_SLUG_REGEX, type ProjectConfig, type WorkspaceError } from "./project-manager.js";
import type { RequestPrincipal } from "./request-principal.js";
import { ownerScopeFromPrincipal } from "./request-principal.js";
import { withProjectLock } from "./state-ops.js";

export const ProjectLifecycleActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("archive") }).strict(),
  z.object({ type: z.literal("restore") }).strict(),
  z.object({
    type: z.literal("delete"),
    confirmation: z.string().min(1).max(128),
  }).strict(),
]);

export type ProjectLifecycleAction = z.infer<typeof ProjectLifecycleActionSchema>;

export interface ProjectLifecycleBlocker {
  type: "session" | "thread" | "review" | "preview" | "worktree";
  label: string;
}

type ProjectManager = Pick<
  ReturnType<typeof createProjectManager>,
  "getProjectForLifecycle" | "listDeletingProjects" | "setProjectLifecycleState" | "removeManagedProject"
>;

type Failure = { ok: false; status: number; error: WorkspaceError };
type Success =
  | { ok: true; action: "archive" | "restore"; project: ProjectConfig }
  | { ok: true; action: "delete"; projectSlug: string };

export type ProjectLifecycleResult = Success | Failure;

function failure(status: number, code: string, message: string): Failure {
  return { ok: false, status, error: { code, message } };
}

export function createProjectLifecycleService(options: {
  projectManager: ProjectManager;
  findBlockers: (project: ProjectConfig, principal: RequestPrincipal) => Promise<ProjectLifecycleBlocker[]>;
  cleanupRelatedState: (project: ProjectConfig, principal: RequestPrincipal) => Promise<void>;
  now?: () => string;
}) {
  const now = options.now ?? (() => new Date().toISOString());

  async function finishDeletion(project: ProjectConfig, principal: RequestPrincipal): Promise<boolean> {
    try {
      await options.cleanupRelatedState(project, principal);
      const removed = await options.projectManager.removeManagedProject({
        slug: project.slug,
        ownerScope: project.ownerScope,
      });
      return removed.ok;
    } catch (err: unknown) {
      console.error("[project-lifecycle] Project deletion cleanup failed:", err);
      return false;
    }
  }

  return {
    async recoverDeletingProjects(): Promise<{ recovered: number; failed: number }> {
      const { projects } = await options.projectManager.listDeletingProjects();
      let recovered = 0;
      let failed = 0;
      for (const tombstone of projects) {
        const succeeded = await withProjectLock(tombstone.slug, async () => {
          const current = await options.projectManager.getProjectForLifecycle({
            slug: tombstone.slug,
            ownerScope: tombstone.ownerScope,
          });
          if (!current.ok || !current.project.deletingAt) return current.ok;
          return finishDeletion(current.project, {
            userId: current.project.ownerScope.id,
            source: "configured-container",
          });
        });
        if (succeeded) recovered += 1;
        else failed += 1;
      }
      return { recovered, failed };
    },

    async applyProjectLifecycleAction(
      principal: RequestPrincipal,
      projectSlug: string,
      rawAction: ProjectLifecycleAction,
    ): Promise<ProjectLifecycleResult> {
      if (!PROJECT_SLUG_REGEX.test(projectSlug)) {
        return failure(400, "invalid_slug", "Project slug is invalid");
      }
      const parsedAction = ProjectLifecycleActionSchema.safeParse(rawAction);
      if (!parsedAction.success) {
        return failure(400, "invalid_request", "Project action is invalid");
      }
      const action = parsedAction.data;
      const ownerScope = ownerScopeFromPrincipal(principal);

      return withProjectLock(projectSlug, async () => {
        const current = await options.projectManager.getProjectForLifecycle({ slug: projectSlug, ownerScope });
        if (!current.ok) return current;
        const project = current.project;

        if (project.deletingAt && action.type !== "delete") {
          return failure(404, "not_found", "Project was not found");
        }

        if (action.type === "restore") {
          if (!project.archivedAt) return { ok: true, action: "restore", project };
          const updated = await options.projectManager.setProjectLifecycleState({
            slug: projectSlug,
            ownerScope,
            archivedAt: null,
          });
          return updated.ok ? { ok: true, action: "restore", project: updated.project } : updated;
        }

        if (action.type === "delete" && action.confirmation !== project.name) {
          return failure(400, "confirmation_mismatch", "Project name confirmation does not match");
        }

        if (!project.deletingAt) {
          let blockers: ProjectLifecycleBlocker[];
          try {
            blockers = await options.findBlockers(project, principal);
          } catch (err: unknown) {
            console.error("[project-lifecycle] Failed to inspect project activity:", err);
            return failure(500, "activity_check_failed", "Project activity could not be checked");
          }
          if (blockers.length > 0) {
            return failure(409, "project_active", "Stop active project work before continuing");
          }
        }

        if (action.type === "archive") {
          if (project.archivedAt) return { ok: true, action: "archive", project };
          const updated = await options.projectManager.setProjectLifecycleState({
            slug: projectSlug,
            ownerScope,
            archivedAt: now(),
          });
          return updated.ok ? { ok: true, action: "archive", project: updated.project } : updated;
        }

        let deletingProject = project;
        if (!project.deletingAt) {
          const marked = await options.projectManager.setProjectLifecycleState({
            slug: projectSlug,
            ownerScope,
            deletingAt: now(),
          });
          if (!marked.ok) return marked;
          deletingProject = marked.project;
        }

        if (!await finishDeletion(deletingProject, principal)) {
          return failure(500, "delete_incomplete", "Project deletion could not be completed");
        }
        return { ok: true, action: "delete", projectSlug };
      });
    },
  };
}
