import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod/v4";
import { createProjectManager } from "./project-manager.js";
import { createWorktreeManager } from "./worktree-manager.js";
import { createStateOps, type OwnerScope } from "./state-ops.js";

type ProjectManager = ReturnType<typeof createProjectManager>;
type WorktreeManager = ReturnType<typeof createWorktreeManager>;

const WORKSPACE_BODY_LIMIT = 64 * 1024;

const CreateProjectSchema = z.object({
  url: z.string().min(1).max(512),
  slug: z.string().min(1).max(63).optional(),
  ownerScope: z.object({
    type: z.enum(["user", "org"]),
    id: z.string().min(1).max(128),
  }).optional(),
});

const CreateWorktreeSchema = z.object({
  branch: z.string().min(1).max(200).optional(),
  pr: z.number().int().positive().optional(),
}).refine((body) => (body.branch ? 1 : 0) + (typeof body.pr === "number" ? 1 : 0) === 1);

const DeleteWorktreeSchema = z.object({
  confirmDirtyDelete: z.boolean().optional(),
});

const ExportWorkspaceSchema = z.object({
  scope: z.enum(["all", "project"]),
  projectSlug: z.string().optional(),
  includeTranscripts: z.boolean().optional(),
  ownerScope: z.object({
    type: z.enum(["user", "org"]),
    id: z.string().min(1).max(128),
  }).optional(),
});

const DeleteWorkspaceSchema = z.object({
  scope: z.literal("project"),
  projectSlug: z.string(),
  confirmation: z.string(),
  ownerScope: z.object({
    type: z.enum(["user", "org"]),
    id: z.string().min(1).max(128),
  }).optional(),
});

function status(code: number): ContentfulStatusCode {
  return code as ContentfulStatusCode;
}

function errorBody(code: string, message: string): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

async function parseJson<T>(c: Context, schema: z.ZodType<T>): Promise<
  { ok: true; value: T } | { ok: false; status: number; code: string; message: string }
> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "BodyLimitError") {
      return { ok: false, status: 413, code: "payload_too_large", message: "Request body is too large" };
    }
    if (err instanceof SyntaxError) {
      return { ok: false, status: 400, code: "invalid_json", message: "Request body must be valid JSON" };
    }
    console.error("[workspace-routes] Failed to parse JSON:", err);
    return { ok: false, status: 400, code: "invalid_json", message: "Request body must be valid JSON" };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, status: 400, code: "invalid_request", message: "Request body is invalid" };
  }
  return { ok: true, value: parsed.data };
}

function ownerScopeFromContext(): OwnerScope {
  return { type: "user", id: "local" };
}

export function createWorkspaceRoutes(options: {
  homePath: string;
  projectManager?: ProjectManager;
  worktreeManager?: WorktreeManager;
}) {
  const app = new Hono();
  const projectManager = options.projectManager ?? createProjectManager({ homePath: options.homePath });
  const worktreeManager = options.worktreeManager ?? createWorktreeManager({ homePath: options.homePath });
  const stateOps = createStateOps({ homePath: options.homePath });
  const limited = bodyLimit({ maxSize: WORKSPACE_BODY_LIMIT });

  app.get("/api/github/status", async (c) => c.json(await projectManager.getGithubStatus()));

  app.post("/api/projects", limited, async (c) => {
    const body = await parseJson(c, CreateProjectSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const result = await projectManager.createProject({
      url: body.value.url,
      slug: body.value.slug,
      ownerScope: body.value.ownerScope ?? ownerScopeFromContext(),
    });
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ project: result.project }, 201);
  });

  app.get("/api/projects", async (c) => {
    const result = await projectManager.listManagedProjects();
    return c.json(result);
  });

  app.get("/api/projects/:slug", async (c) => {
    const result = await projectManager.getProject(c.req.param("slug"));
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ project: result.project });
  });

  app.delete("/api/projects/:slug", async (c) => {
    const result = await projectManager.deleteProject(c.req.param("slug"));
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ ok: true });
  });

  app.get("/api/projects/:slug/prs", async (c) => {
    const result = await projectManager.listPullRequests(c.req.param("slug"));
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ prs: result.prs, refreshedAt: result.refreshedAt });
  });

  app.get("/api/projects/:slug/branches", async (c) => {
    const result = await projectManager.listBranches(c.req.param("slug"));
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ branches: result.branches, refreshedAt: result.refreshedAt });
  });

  app.post("/api/projects/:slug/worktrees", limited, async (c) => {
    const body = await parseJson(c, CreateWorktreeSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const result = await worktreeManager.createWorktree({
      projectSlug: c.req.param("slug"),
      branch: body.value.branch,
      pr: body.value.pr,
    });
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ worktree: result.worktree }, result.status);
  });

  app.get("/api/projects/:slug/worktrees", async (c) => {
    const result = await worktreeManager.listWorktrees(c.req.param("slug"));
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ worktrees: result.worktrees });
  });

  app.delete("/api/projects/:slug/worktrees/:worktreeId", limited, async (c) => {
    const body = await parseJson(c, DeleteWorktreeSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const result = await worktreeManager.deleteWorktree({
      projectSlug: c.req.param("slug"),
      worktreeId: c.req.param("worktreeId"),
      confirmDirtyDelete: body.value.confirmDirtyDelete,
    });
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ ok: true });
  });

  app.post("/api/workspace/export", limited, async (c) => {
    const body = await parseJson(c, ExportWorkspaceSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const manifest = await stateOps.exportWorkspace(body.value);
    return c.json({ export: { id: manifest.id, status: "complete", files: manifest.files } }, 202);
  });

  app.delete("/api/workspace/data", limited, async (c) => {
    const body = await parseJson(c, DeleteWorkspaceSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const result = await stateOps.deleteWorkspaceData(body.value);
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ ok: true });
  });

  return app;
}
