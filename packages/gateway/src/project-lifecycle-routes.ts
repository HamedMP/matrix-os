import type { Context, Hono, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { TerminalRuntimeSocketClient } from "@matrix-os/terminal-runtime";
import { z } from "zod/v4";
import { requestHasBody } from "./http-body.js";
import { PROJECT_SLUG_REGEX, type createProjectManager } from "./project-manager.js";
import { ProjectLifecycleActionSchema, type createProjectLifecycleService, type ProjectLifecycleAction } from "./project-lifecycle.js";
import type { OwnerScope } from "./state-ops.js";
import type { OwnerProjectDeletion } from "./collaboration/owner-project-deletion.js";

const CompatibilityDeleteSchema = z.object({
  confirmation: z.string().min(1).max(128), confirmTerminate: z.boolean().optional(),
}).strict();

export interface ProjectOperationAdmitter {
  <T>(input: {
    ownerScope: OwnerScope; projectSlug: string; projectId?: string; kind: "write" | "run";
    operation(projectId?: string): Promise<T>;
  }): Promise<{ ok: true; value: T } | { ok: false; status: number; body: { error: unknown } }>;
}

/** Personal and shared deletion use one owner-confirmed entry point for every client. */
export function registerProjectLifecycleRoutes(app: Hono, options: {
  limited: MiddlewareHandler;
  projectManager: Pick<ReturnType<typeof createProjectManager>, "getProjectForLifecycle">;
  localLifecycle: Pick<ReturnType<typeof createProjectLifecycleService>, "applyProjectLifecycleAction">;
  sharedDeletion?: OwnerProjectDeletion;
  terminalRuntime: Pick<TerminalRuntimeSocketClient, "listWorkspaces" | "deletionImpact">;
  getOwnerScope(c: Context): OwnerScope;
  principalError(c: Context, error: unknown): Response;
  admit: ProjectOperationAdmitter;
}) {
  async function apply(c: Context, action: ProjectLifecycleAction) {
    const slug = c.req.param("slug")!;
    if (!PROJECT_SLUG_REGEX.test(slug)) return c.json({ error: { code: "invalid_slug", message: "Project slug is invalid" } }, 400);
    let ownerScope: OwnerScope;
    try { ownerScope = options.getOwnerScope(c); } catch (error: unknown) { return options.principalError(c, error); }
    const principal = { userId: ownerScope.id, source: "configured-container" as const };
    let projectId: string | undefined;
    if (action.type === "delete") {
      const current = await options.projectManager.getProjectForLifecycle({ slug, ownerScope });
      if (!current.ok) return c.json({ error: current.error }, current.status as ContentfulStatusCode);
      const project = current.project;
      projectId = project.id;
      if (action.confirmation !== project.name) return c.json({ error: { code: "confirmation_mismatch", message: "Project name confirmation does not match" } }, 400);
      try {
        const workspace = (await options.terminalRuntime.listWorkspaces())
          .find(candidate => candidate.scope === "project" && candidate.projectId === project.id);
        if (workspace) {
          const impact = await options.terminalRuntime.deletionImpact(workspace.id);
          if (impact.runningTabs > 0 && !action.confirmTerminate) return c.json({
            error: { code: "terminal_termination_confirmation_required", message: "Project has running terminal tabs" }, ...impact,
          }, 409);
        }
      } catch (error: unknown) {
        console.error("[project-lifecycle-routes] Terminal impact unavailable", error);
        return c.json({ error: { code: "terminal_runtime_unavailable", message: "Project could not be deleted" } }, 503);
      }
      const shared = await options.sharedDeletion?.apply(principal, project, action);
      if (shared) return shared.ok ? c.json(shared) : c.json({ error: shared.error }, shared.status as ContentfulStatusCode);
    }
    const admitted = await options.admit({ ownerScope, projectSlug: slug, projectId, kind: "write",
      operation: () => options.localLifecycle.applyProjectLifecycleAction(principal, slug, action),
    });
    if (!admitted.ok) return c.json(admitted.body, admitted.status as ContentfulStatusCode);
    const result = admitted.value;
    return result.ok ? c.json(result) : c.json({ error: result.error }, result.status as ContentfulStatusCode);
  }

  async function readAction(c: Context, compatibility: boolean) {
    let value: unknown;
    try {
      if (!requestHasBody(c)) return c.json({ error: { code: "invalid_json", message: "Request body must be valid JSON" } }, 400);
      value = await c.req.json();
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) throw error;
      return c.json({ error: { code: "invalid_json", message: "Request body must be valid JSON" } }, 400);
    }
    if (compatibility) {
      const parsed = CompatibilityDeleteSchema.safeParse(value);
      if (!parsed.success) return c.json({ error: { code: "invalid_request", message: "Request body is invalid" } }, 400);
      return apply(c, { type: "delete", ...parsed.data });
    }
    const parsed = ProjectLifecycleActionSchema.safeParse(value);
    if (!parsed.success) return c.json({ error: { code: "invalid_request", message: "Request body is invalid" } }, 400);
    return apply(c, parsed.data);
  }

  app.post("/api/projects/:slug/actions", options.limited, c => readAction(c, false));
  app.delete("/api/projects/:slug", options.limited, c => readAction(c, true));
}
