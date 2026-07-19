import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { createProjectManager, GitBranchSchema, PROJECT_SLUG_REGEX } from "./project-manager.js";
import { createProjectFolders } from "./project-folders.js";
import { createGitLog, COMMIT_SHA_REGEX } from "./git-log.js";
import { createWorktreeManager } from "./worktree-manager.js";
import { createStateOps, type OwnerScope } from "./state-ops.js";
import { createAgentLauncher } from "./agent-launcher.js";
import { PromptContentSchema } from "./prompt-validation.js";
import { createAgentSessionManager } from "./agent-session-manager.js";
import { createAgentSandbox } from "./agent-sandbox.js";
import { SessionRegistry } from "./session-registry.js";
import { createSessionRuntimeBridge } from "./session-runtime-bridge.js";
import { createZellijRuntime } from "./zellij-runtime.js";
import { approveReview, createReviewLoopRecord, startNextReviewRound, stopReview } from "./review-loop.js";
import { createReviewStore } from "./review-store.js";
import { createTaskManager } from "./task-manager.js";
import { createPreviewManager } from "./preview-manager.js";
import { createWorkspaceEventStore } from "./workspace-events.js";
import { isRequestPrincipalError, mapRequestPrincipalError, ownerScopeFromPrincipal, requireRequestPrincipal } from "./request-principal.js";
import { createWorkspaceEventPublisher, type WorkspaceEventPublisher } from "./workspace-event-publisher.js";
import { createWorkspaceSessionOrchestrator, type WorkspaceSessionOrchestrator } from "./workspace-session-orchestrator.js";
import { requestHasBody } from "./http-body.js";

type ProjectManager = ReturnType<typeof createProjectManager>;
type ProjectFolders = ReturnType<typeof createProjectFolders>;
type GitLog = ReturnType<typeof createGitLog>;
type WorktreeManager = ReturnType<typeof createWorktreeManager>;
type AgentLauncher = ReturnType<typeof createAgentLauncher>;
type AgentSessionManager = ReturnType<typeof createAgentSessionManager>;
type AgentSandbox = ReturnType<typeof createAgentSandbox>;
type SessionRuntimeBridge = ReturnType<typeof createSessionRuntimeBridge>;
type ZellijRuntime = ReturnType<typeof createZellijRuntime>;
type ReviewStore = ReturnType<typeof createReviewStore>;
type TaskManager = ReturnType<typeof createTaskManager>;
type PreviewManager = ReturnType<typeof createPreviewManager>;
type WorkspaceEventStore = ReturnType<typeof createWorkspaceEventStore>;

const WORKSPACE_BODY_LIMIT = 64 * 1024;

const CreateProjectSchema = z.object({
  url: z.string().min(1).max(512).optional(),
  slug: z.string().min(1).max(63).optional(),
  name: z.string().trim().min(1).max(128).optional(),
  path: z.string().min(1).max(4096).optional(),
  branch: GitBranchSchema.optional(),
  mode: z.enum(["scratch", "github", "folder"]).optional(),
  ownerScope: z.object({
    type: z.enum(["user", "org"]),
    id: z.string().min(1).max(128),
  }).optional(),
}).superRefine((body, ctx) => {
  const mode = body.mode ?? (body.url ? "github" : "scratch");
  if (mode === "github" && !body.url) {
    ctx.addIssue({
      code: "custom",
      path: ["url"],
      message: "Repository URL is required",
    });
  }
  if (mode === "scratch" && !body.name && !body.slug) {
    ctx.addIssue({
      code: "custom",
      path: ["name"],
      message: "Project name is required",
    });
  }
  if (mode === "folder" && (!body.name || !body.path)) {
    ctx.addIssue({
      code: "custom",
      path: [body.name ? "path" : "name"],
      message: "Folder projects require a name and path",
    });
  }
});

// Desktop add-project clone flow. Stricter than the generic create route:
// https GitHub URLs only (no ssh, no userinfo, no other hosts — the anchored
// regex rejects credentials by construction) and the target folder name must
// already be a safe slug.
const CloneProjectSchema = z.object({
  url: z.string().trim().min(1).max(512).regex(
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(\.git)?\/?$/,
  ),
  name: z.string().trim().regex(PROJECT_SLUG_REGEX).optional(),
  branch: GitBranchSchema.optional(),
});

const MkdirFolderSchema = z.object({
  name: z.string().trim().regex(PROJECT_SLUG_REGEX),
  parent: z.string().trim().min(1).max(1024).optional(),
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
  projectSlug: z.string().regex(PROJECT_SLUG_REGEX),
  confirmation: z.string(),
  ownerScope: z.object({
    type: z.enum(["user", "org"]),
    id: z.string().min(1).max(128),
  }).optional(),
});

const StartSessionSchema = z.object({
  sessionId: z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/).optional(),
  projectSlug: z.string().min(1).max(63).optional(),
  taskId: z.string().min(1).max(128).optional(),
  worktreeId: z.string().min(1).max(128).optional(),
  pr: z.number().int().positive().optional(),
  kind: z.enum(["shell", "agent"]),
  agent: z.enum(["claude", "codex", "opencode", "pi"]).optional(),
  prompt: PromptContentSchema.optional(),
  runtimePreference: z.enum(["zellij"]).optional(),
  adminSandboxOverride: z.boolean().optional(),
});

const SendSessionInputSchema = z.object({
  input: z.string().min(1).max(64 * 1024),
});

const EmptyObjectSchema = z.object({}).passthrough();

const CreateReviewSchema = z.object({
  projectSlug: z.string().min(1).max(63),
  worktreeId: z.string().min(1).max(128),
  pr: z.number().int().positive(),
  reviewer: z.enum(["claude", "codex", "opencode", "pi"]),
  implementer: z.enum(["claude", "codex", "opencode", "pi"]),
  maxRounds: z.number().int().min(1).max(20).default(5),
  convergenceGate: z.enum(["findings_only", "findings_and_verify"]).default("findings_only"),
  verificationCommands: z.array(z.string().min(1).max(500)).max(20).default([]),
});

const CreateTaskSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(10_000).optional(),
  status: z.enum(["todo", "running", "waiting", "blocked", "complete", "archived"]).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  order: z.number().finite().optional(),
  parentTaskId: z.string().min(1).max(128).optional(),
  dueAt: z.string().min(1).max(64).optional(),
  linkedSessionId: z.string().min(1).max(128).optional(),
  linkedWorktreeId: z.string().min(1).max(128).optional(),
  previewIds: z.array(z.string().min(1).max(128)).max(20).optional(),
});

const UpdateTaskSchema = CreateTaskSchema.partial();

const CreatePreviewSchema = z.object({
  taskId: z.string().min(1).max(128).optional(),
  sessionId: z.string().min(1).max(128).optional(),
  label: z.string().min(1).max(120),
  url: z.string().min(1).max(2048),
  displayPreference: z.enum(["panel", "external"]).optional(),
});

const UpdatePreviewSchema = CreatePreviewSchema.partial().extend({
  lastStatus: z.enum(["unknown", "ok", "failed"]).optional(),
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

export function createWorkspaceRoutes(options: {
  homePath: string;
  projectManager?: ProjectManager;
  projectFolders?: ProjectFolders;
  gitLog?: GitLog;
  worktreeManager?: WorktreeManager;
  agentLauncher?: AgentLauncher;
  agentSessionManager?: AgentSessionManager;
  agentSandbox?: AgentSandbox;
  zellijRuntime?: ZellijRuntime;
  sessionRuntimeBridge?: SessionRuntimeBridge;
  reviewStore?: ReviewStore;
  taskManager?: TaskManager;
  previewManager?: PreviewManager;
  eventStore?: WorkspaceEventStore;
  eventPublisher?: WorkspaceEventPublisher;
  sessionOrchestrator?: WorkspaceSessionOrchestrator;
  getOwnerScope?: (c: Context) => OwnerScope;
}) {
  const app = new Hono();
  const projectManager = options.projectManager ?? createProjectManager({ homePath: options.homePath });
  const projectFolders = options.projectFolders ?? createProjectFolders({ homePath: options.homePath });
  const gitLog = options.gitLog ?? createGitLog({ homePath: options.homePath });
  const worktreeManager = options.worktreeManager ?? createWorktreeManager({ homePath: options.homePath });
  const agentLauncher = options.agentLauncher ?? createAgentLauncher({ cwd: options.homePath, runtimeHome: options.homePath });
  const zellijRuntime = options.zellijRuntime ?? createZellijRuntime({ homePath: options.homePath });
  const agentSessionManager = options.agentSessionManager ?? createAgentSessionManager({
    homePath: options.homePath,
    worktreeManager,
    agentLauncher,
    zellijRuntime,
    inputWriter: (sessionId, input, signal) => zellijRuntime.sendInput(sessionId, input, signal),
  });
  const agentSandbox = options.agentSandbox ?? createAgentSandbox({ homePath: options.homePath });
  // Defense in depth: when the caller forgets to inject sessionRuntimeBridge,
  // construct a bridge whose registry does NOT auto-restore from the persist
  // file. Otherwise this fallback races server.ts's primary registry on the
  // same `<home>/system/terminal-sessions.json`, double-spawning bash children
  // for every persisted session on every gateway boot.
  const sessionRuntimeBridge = options.sessionRuntimeBridge ?? createSessionRuntimeBridge({
    homePath: options.homePath,
    registry: new SessionRegistry(options.homePath, { autoRestore: false }),
    zellijRuntime,
  });
  const reviewStore = options.reviewStore ?? createReviewStore({ homePath: options.homePath });
  const taskManager = options.taskManager ?? createTaskManager({ homePath: options.homePath });
  const previewManager = options.previewManager ?? createPreviewManager({ homePath: options.homePath });
  const eventStore = options.eventStore ?? createWorkspaceEventStore({ homePath: options.homePath });
  const eventPublisher = options.eventPublisher ?? createWorkspaceEventPublisher({ eventStore });
  const sessionOrchestrator = options.sessionOrchestrator ?? createWorkspaceSessionOrchestrator({
    projectManager,
    worktreeManager,
    agentSessionManager,
    agentSandbox,
    sessionRuntimeBridge,
    eventPublisher,
  });
  const stateOps = createStateOps({ homePath: options.homePath });
  const limited = bodyLimit({ maxSize: WORKSPACE_BODY_LIMIT });
  const getOwnerScope = options.getOwnerScope ?? ((c: Context) => ownerScopeFromPrincipal(requireRequestPrincipal(c, {
    requireAuthContextReady: false,
  })));

  function principalError(c: Context, err: unknown) {
    if (!isRequestPrincipalError(err)) throw err;
    const mapped = mapRequestPrincipalError(err, "Workspace request failed");
    if (mapped.log) console.error("[workspace-routes] Request principal misconfigured:", err.name);
    if (mapped.status === 401) {
      return c.json(errorBody("unauthorized", "Unauthorized"), 401);
    }
    return c.json(errorBody("server_misconfigured", mapped.body.error), 500);
  }

  app.get("/api/github/status", async (c) => c.json(await projectManager.getGithubStatus()));

  const GithubReposQuerySchema = z.object({
    search: z.string().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).default(50).transform((v) => Math.min(v, 50)),
  });

  app.get("/api/github/repos", async (c) => {
    try {
      getOwnerScope(c);
    } catch (err: unknown) {
      return principalError(c, err);
    }
    const parsed = GithubReposQuerySchema.safeParse({
      search: c.req.query("search"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      return c.json(errorBody("invalid_query", "Invalid query parameters"), 400);
    }
    try {
      const result = await projectManager.listGithubRepos({
        search: parsed.data.search,
        limit: parsed.data.limit,
      });
      return c.json(result);
    } catch (err: unknown) {
      console.error("[github/repos] list failed:", err instanceof Error ? err.message : typeof err);
      return c.json({ error: "github_unavailable" }, 502);
    }
  });

  app.post("/api/projects", limited, async (c) => {
    const body = await parseJson(c, CreateProjectSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    let ownerScope: OwnerScope;
    try {
      ownerScope = getOwnerScope(c);
    } catch (err: unknown) {
      return principalError(c, err);
    }
    const result = await projectManager.createProject({
      url: body.value.url,
      slug: body.value.slug,
      name: body.value.name,
      path: body.value.path,
      branch: body.value.branch,
      mode: body.value.mode ?? (body.value.url ? "github" : "scratch"),
      ownerScope,
    });
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ project: result.project }, 201);
  });

  // Purpose-specific add-project endpoints used by the desktop dialog. Both
  // delegate to the same managers as the generic routes so locking,
  // idempotency, and conflict semantics stay in one place.
  app.post("/api/projects/clone", limited, async (c) => {
    const body = await parseJson(c, CloneProjectSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    let ownerScope: OwnerScope;
    try {
      ownerScope = getOwnerScope(c);
    } catch (err: unknown) {
      return principalError(c, err);
    }
    const result = await projectManager.createProject({
      mode: "github",
      url: body.value.url,
      slug: body.value.name,
      branch: body.value.branch,
      ownerScope,
    });
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ project: result.project }, 201);
  });

  app.post("/api/projects/mkdir", limited, async (c) => {
    const body = await parseJson(c, MkdirFolderSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    try {
      getOwnerScope(c);
    } catch (err: unknown) {
      return principalError(c, err);
    }
    const result = await projectFolders.createFolder({
      name: body.value.name,
      parent: body.value.parent,
    });
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ path: result.path }, 201);
  });

  app.get("/api/workspace/projects", async (c) => {
    const result = await projectManager.listManagedProjects();
    return c.json(result);
  });

  app.get("/api/projects/:slug", async (c) => {
    const result = await projectManager.getProject(c.req.param("slug"));
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ project: result.project });
  });

  app.delete("/api/projects/:slug", limited, async (c) => {
    if (requestHasBody(c)) {
      const body = await parseJson(c, EmptyObjectSchema);
      if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    }
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

  const ListCommitsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(500).default(200),
    cursor: z.string().regex(/^\d{1,7}$/).optional(),
  });

  app.get("/api/projects/:slug/commits", async (c) => {
    const query = ListCommitsQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json(errorBody("invalid_request", "Query parameters are invalid"), 400);
    const result = await gitLog.listCommits(c.req.param("slug"), {
      limit: query.data.limit,
      offset: query.data.cursor ? Number(query.data.cursor) : 0,
    });
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ commits: result.commits, nextCursor: result.nextCursor, refreshedAt: result.refreshedAt });
  });

  const CommitDiffQuerySchema = z.object({
    maxFiles: z.coerce.number().int().min(1).max(500).default(200),
    maxLines: z.coerce.number().int().min(50).max(2000).default(400),
  });

  app.get("/api/projects/:slug/commits/:sha/diff", async (c) => {
    const sha = z.string().regex(COMMIT_SHA_REGEX).safeParse(c.req.param("sha"));
    const query = CommitDiffQuerySchema.safeParse(c.req.query());
    if (!sha.success || !query.success) {
      return c.json(errorBody("invalid_request", "Request parameters are invalid"), 400);
    }
    const result = await gitLog.getCommitDiff(c.req.param("slug"), sha.data, {
      maxFiles: query.data.maxFiles,
      maxLines: query.data.maxLines,
    });
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ files: result.files, truncated: result.truncated, refreshedAt: result.refreshedAt });
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
    let confirmDirtyDelete: boolean | undefined;
    if (requestHasBody(c)) {
      const body = await parseJson(c, DeleteWorktreeSchema);
      if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
      confirmDirtyDelete = body.value.confirmDirtyDelete;
    }
    const result = await worktreeManager.deleteWorktree({
      projectSlug: c.req.param("slug"),
      worktreeId: c.req.param("worktreeId"),
      confirmDirtyDelete,
    });
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ ok: true });
  });

  app.post("/api/projects/:slug/tasks", limited, async (c) => {
    const body = await parseJson(c, CreateTaskSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const projectSlug = c.req.param("slug");
    const result = await taskManager.createTask(projectSlug, body.value);
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    await eventPublisher.publishTaskCreated(result.task);
    return c.json({ task: result.task }, status(result.status ?? 201));
  });

  app.get("/api/projects/:slug/tasks", async (c) => {
    const limitRaw = c.req.query("limit");
    const result = await taskManager.listTasks(c.req.param("slug"), {
      includeArchived: c.req.query("includeArchived") === "true",
      limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
      cursor: c.req.query("cursor"),
    });
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ tasks: result.tasks, nextCursor: result.nextCursor });
  });

  app.patch("/api/projects/:slug/tasks/:taskId", limited, async (c) => {
    const body = await parseJson(c, UpdateTaskSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const projectSlug = c.req.param("slug");
    const result = await taskManager.updateTask(projectSlug, c.req.param("taskId"), body.value);
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    await eventPublisher.publishTaskUpdated(result.task);
    return c.json({ task: result.task });
  });

  app.delete("/api/projects/:slug/tasks/:taskId", limited, async (c) => {
    const body = await parseJson(c, EmptyObjectSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const projectSlug = c.req.param("slug");
    const taskId = c.req.param("taskId");
    const result = await taskManager.deleteTask(projectSlug, taskId);
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    await eventPublisher.publishTaskDeleted(projectSlug, taskId);
    return c.json({ ok: true });
  });

  app.post("/api/projects/:slug/previews", limited, async (c) => {
    const body = await parseJson(c, CreatePreviewSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const projectSlug = c.req.param("slug");
    const result = await previewManager.createPreview(projectSlug, body.value);
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    await eventPublisher.publishPreviewCreated(result.preview);
    return c.json({ preview: result.preview }, status(result.status ?? 201));
  });

  app.get("/api/projects/:slug/previews", async (c) => {
    const limitRaw = c.req.query("limit");
    const result = await previewManager.listPreviews(c.req.param("slug"), {
      taskId: c.req.query("taskId"),
      sessionId: c.req.query("sessionId"),
      limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
      cursor: c.req.query("cursor"),
    });
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ previews: result.previews, nextCursor: result.nextCursor });
  });

  app.patch("/api/projects/:slug/previews/:previewId", limited, async (c) => {
    const body = await parseJson(c, UpdatePreviewSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const projectSlug = c.req.param("slug");
    const result = await previewManager.updatePreview(projectSlug, c.req.param("previewId"), body.value);
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    await eventPublisher.publishPreviewUpdated(result.preview);
    return c.json({ preview: result.preview });
  });

  app.delete("/api/projects/:slug/previews/:previewId", limited, async (c) => {
    const body = await parseJson(c, EmptyObjectSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const projectSlug = c.req.param("slug");
    const previewId = c.req.param("previewId");
    const result = await previewManager.deletePreview(projectSlug, previewId);
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    await eventPublisher.publishPreviewDeleted(projectSlug, previewId);
    return c.json({ ok: true });
  });

  app.post("/api/sessions", limited, async (c) => {
    const body = await parseJson(c, StartSessionSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    let ownerScope: OwnerScope;
    try {
      ownerScope = getOwnerScope(c);
    } catch (err: unknown) {
      return principalError(c, err);
    }
    const result = await sessionOrchestrator.startSession({
      ownerScope,
      request: body.value,
    });
    if (!result.ok) {
      if ("sandboxStatus" in result) {
        return c.json({ error: result.error, sandboxStatus: result.sandboxStatus }, status(result.status));
      }
      return c.json({ error: result.error }, status(result.status));
    }
    return c.json({ session: result.session }, status(result.status));
  });

  app.get("/api/sessions", async (c) => {
    const prRaw = c.req.query("pr");
    const limitRaw = c.req.query("limit");
    const result = await sessionOrchestrator.listSessions({
      projectSlug: c.req.query("projectSlug"),
      taskId: c.req.query("taskId"),
      status: c.req.query("status"),
      pr: prRaw ? Number.parseInt(prRaw, 10) : undefined,
      limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
      cursor: c.req.query("cursor"),
    });
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ sessions: result.sessions, nextCursor: result.nextCursor });
  });

  app.get("/api/sessions/:sessionId", async (c) => {
    const result = await sessionOrchestrator.getSession(c.req.param("sessionId"));
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ session: result.session });
  });

  app.post("/api/sessions/:sessionId/send", limited, async (c) => {
    const body = await parseJson(c, SendSessionInputSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const result = await sessionOrchestrator.sendInput(c.req.param("sessionId"), body.value.input);
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ session: result.session });
  });

  app.post("/api/sessions/:sessionId/observe", limited, async (c) => {
    const body = await parseJson(c, EmptyObjectSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const result = await sessionOrchestrator.attachSession(c.req.param("sessionId"), "observe");
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json(result);
  });

  app.post("/api/sessions/:sessionId/takeover", limited, async (c) => {
    const body = await parseJson(c, EmptyObjectSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const result = await sessionOrchestrator.attachSession(c.req.param("sessionId"), "owner");
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json(result);
  });

  app.delete("/api/sessions/:sessionId", limited, async (c) => {
    const body = await parseJson(c, EmptyObjectSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const result = await sessionOrchestrator.stopSession(c.req.param("sessionId"));
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ session: result.session });
  });

  app.get("/api/agents", async (c) => c.json(await agentLauncher.detectAgentInstallations()));

  app.get("/api/agents/sandbox-status", async (c) => c.json(await agentSandbox.status()));

  app.get("/api/workspace/events", async (c) => {
    const limitRaw = c.req.query("limit");
    const result = await eventStore.listEvents({
      projectSlug: c.req.query("projectSlug"),
      taskId: c.req.query("taskId"),
      sessionId: c.req.query("sessionId"),
      reviewId: c.req.query("reviewId"),
      previewId: c.req.query("previewId"),
      limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
      cursor: c.req.query("cursor"),
    });
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ events: result.events, nextCursor: result.nextCursor });
  });

  app.post("/api/reviews", limited, async (c) => {
    const body = await parseJson(c, CreateReviewSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const ownerScope = options.getOwnerScope?.(c);
    const review = createReviewLoopRecord({
      id: `rev_${randomUUID()}`,
      ownerId: ownerScope?.id,
      ...body.value,
    });
    const saved = await reviewStore.saveReview(review);
    if (!saved.ok) return c.json({ error: saved.error }, status(saved.status));
    return c.json({ review }, 201);
  });

  app.get("/api/reviews", async (c) => {
    const limitRaw = c.req.query("limit");
    const result = await reviewStore.listReviews({
      projectSlug: c.req.query("projectSlug"),
      limit: limitRaw ? Number.parseInt(limitRaw, 10) : undefined,
      cursor: c.req.query("cursor"),
    });
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ reviews: result.reviews, nextCursor: result.nextCursor });
  });

  app.get("/api/reviews/:reviewId", async (c) => {
    const result = await reviewStore.getReview(c.req.param("reviewId"));
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ review: result.review });
  });

  app.post("/api/reviews/:reviewId/next", limited, async (c) => {
    const body = await parseJson(c, EmptyObjectSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const current = await reviewStore.getReview(c.req.param("reviewId"));
    if (!current.ok) return c.json({ error: current.error }, status(current.status));
    const next = startNextReviewRound(current.review, { sessionId: `sess_${randomUUID()}` });
    if (!next.ok) return c.json({ error: next.error }, status(next.status));
    const saved = await reviewStore.saveReview(next.review);
    if (!saved.ok) return c.json({ error: saved.error }, status(saved.status));
    return c.json({ review: next.review });
  });

  app.post("/api/reviews/:reviewId/approve", limited, async (c) => {
    const body = await parseJson(c, EmptyObjectSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const current = await reviewStore.getReview(c.req.param("reviewId"));
    if (!current.ok) return c.json({ error: current.error }, status(current.status));
    const approved = approveReview(current.review, {});
    if (!approved.ok) return c.json({ error: approved.error }, status(approved.status));
    const saved = await reviewStore.saveReview(approved.review);
    if (!saved.ok) return c.json({ error: saved.error }, status(saved.status));
    return c.json({ review: approved.review });
  });

  app.post("/api/reviews/:reviewId/stop", limited, async (c) => {
    const body = await parseJson(c, EmptyObjectSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const current = await reviewStore.getReview(c.req.param("reviewId"));
    if (!current.ok) return c.json({ error: current.error }, status(current.status));
    const stopped = stopReview(current.review, {});
    if (!stopped.ok) return c.json({ error: stopped.error }, status(stopped.status));
    const saved = await reviewStore.saveReview(stopped.review);
    if (!saved.ok) return c.json({ error: saved.error }, status(saved.status));
    return c.json({ review: stopped.review });
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
