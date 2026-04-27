import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { createProjectManager, PROJECT_SLUG_REGEX } from "./project-manager.js";
import { createWorktreeManager } from "./worktree-manager.js";
import { createStateOps, type OwnerScope } from "./state-ops.js";
import { createAgentLauncher } from "./agent-launcher.js";
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

type ProjectManager = ReturnType<typeof createProjectManager>;
type WorktreeManager = ReturnType<typeof createWorktreeManager>;
type AgentLauncher = ReturnType<typeof createAgentLauncher>;
type AgentSessionManager = ReturnType<typeof createAgentSessionManager>;
type AgentSandbox = ReturnType<typeof createAgentSandbox>;
type SessionRuntimeBridge = ReturnType<typeof createSessionRuntimeBridge>;
type ReviewStore = ReturnType<typeof createReviewStore>;
type TaskManager = ReturnType<typeof createTaskManager>;
type PreviewManager = ReturnType<typeof createPreviewManager>;
type WorkspaceEventStore = ReturnType<typeof createWorkspaceEventStore>;

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
  prompt: z.string().max(100_000).optional(),
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

function ownerScopeFromContext(): OwnerScope {
  return { type: "user", id: "local" };
}

export function createWorkspaceRoutes(options: {
  homePath: string;
  projectManager?: ProjectManager;
  worktreeManager?: WorktreeManager;
  agentLauncher?: AgentLauncher;
  agentSessionManager?: AgentSessionManager;
  agentSandbox?: AgentSandbox;
  sessionRuntimeBridge?: SessionRuntimeBridge;
  reviewStore?: ReviewStore;
  taskManager?: TaskManager;
  previewManager?: PreviewManager;
  eventStore?: WorkspaceEventStore;
}) {
  const app = new Hono();
  const projectManager = options.projectManager ?? createProjectManager({ homePath: options.homePath });
  const worktreeManager = options.worktreeManager ?? createWorktreeManager({ homePath: options.homePath });
  const agentLauncher = options.agentLauncher ?? createAgentLauncher({ cwd: options.homePath });
  const zellijRuntime = createZellijRuntime({ homePath: options.homePath });
  const agentSessionManager = options.agentSessionManager ?? createAgentSessionManager({
    homePath: options.homePath,
    worktreeManager,
    agentLauncher,
    zellijRuntime,
  });
  const agentSandbox = options.agentSandbox ?? createAgentSandbox({ homePath: options.homePath });
  const sessionRuntimeBridge = options.sessionRuntimeBridge ?? createSessionRuntimeBridge({
    homePath: options.homePath,
    registry: new SessionRegistry(options.homePath),
    zellijRuntime,
  });
  const reviewStore = options.reviewStore ?? createReviewStore({ homePath: options.homePath });
  const taskManager = options.taskManager ?? createTaskManager({ homePath: options.homePath });
  const previewManager = options.previewManager ?? createPreviewManager({ homePath: options.homePath });
  const eventStore = options.eventStore ?? createWorkspaceEventStore({ homePath: options.homePath });
  const stateOps = createStateOps({ homePath: options.homePath });
  const limited = bodyLimit({ maxSize: WORKSPACE_BODY_LIMIT });

  async function publishWorkspaceEvent(input: Parameters<WorkspaceEventStore["publishEvent"]>[0]): Promise<void> {
    const result = await eventStore.publishEvent(input);
    if (!result.ok) {
      console.warn("[workspace-routes] Failed to publish workspace event:", result.error.code);
    }
  }

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

  app.get("/api/workspace/projects", async (c) => {
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

  app.post("/api/projects/:slug/tasks", limited, async (c) => {
    const body = await parseJson(c, CreateTaskSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const projectSlug = c.req.param("slug");
    const result = await taskManager.createTask(projectSlug, body.value);
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    await publishWorkspaceEvent({
      type: "task.created",
      scope: { projectSlug, taskId: result.task.id },
      payload: { title: result.task.title, status: result.task.status },
    });
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
    await publishWorkspaceEvent({
      type: "task.updated",
      scope: { projectSlug, taskId: result.task.id },
      payload: { status: result.task.status, updatedAt: result.task.updatedAt },
    });
    return c.json({ task: result.task });
  });

  app.delete("/api/projects/:slug/tasks/:taskId", limited, async (c) => {
    const body = await parseJson(c, EmptyObjectSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const projectSlug = c.req.param("slug");
    const taskId = c.req.param("taskId");
    const result = await taskManager.deleteTask(projectSlug, taskId);
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    await publishWorkspaceEvent({
      type: "task.deleted",
      scope: { projectSlug, taskId },
      payload: {},
    });
    return c.json({ ok: true });
  });

  app.post("/api/projects/:slug/previews", limited, async (c) => {
    const body = await parseJson(c, CreatePreviewSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const projectSlug = c.req.param("slug");
    const result = await previewManager.createPreview(projectSlug, body.value);
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    await publishWorkspaceEvent({
      type: "preview.created",
      scope: { projectSlug, taskId: result.preview.taskId, sessionId: result.preview.sessionId, previewId: result.preview.id },
      payload: { url: result.preview.url, lastStatus: result.preview.lastStatus },
    });
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
    await publishWorkspaceEvent({
      type: "preview.updated",
      scope: { projectSlug, taskId: result.preview.taskId, sessionId: result.preview.sessionId, previewId: result.preview.id },
      payload: { lastStatus: result.preview.lastStatus, updatedAt: result.preview.updatedAt },
    });
    return c.json({ preview: result.preview });
  });

  app.delete("/api/projects/:slug/previews/:previewId", limited, async (c) => {
    const body = await parseJson(c, EmptyObjectSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const projectSlug = c.req.param("slug");
    const previewId = c.req.param("previewId");
    const result = await previewManager.deletePreview(projectSlug, previewId);
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    await publishWorkspaceEvent({
      type: "preview.deleted",
      scope: { projectSlug, previewId },
      payload: {},
    });
    return c.json({ ok: true });
  });

  app.post("/api/sessions", limited, async (c) => {
    const body = await parseJson(c, StartSessionSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const sessionId = body.value.sessionId ?? `sess_${randomUUID()}`;
    let sandbox;
    if (body.value.agent === "codex") {
      if (!body.value.projectSlug || !body.value.worktreeId) {
        return c.json(errorBody("sandbox_unavailable", "Agent sandbox is unavailable"), 400);
      }
      const worktrees = await worktreeManager.listWorktrees(body.value.projectSlug);
      if (!worktrees.ok) return c.json({ error: worktrees.error }, status(worktrees.status));
      const worktree = worktrees.worktrees.find((entry) => entry.id === body.value.worktreeId);
      if (!worktree) return c.json(errorBody("not_found", "Worktree was not found"), 404);
      const preflight = await agentSandbox.preflight({
        agent: "codex",
        sessionId,
        worktreePath: worktree.path,
        adminOverride: body.value.adminSandboxOverride,
      });
      if (!preflight.ok) return c.json({ error: preflight.error, sandboxStatus: preflight.sandboxStatus }, status(preflight.status));
      sandbox = preflight.sandbox;
    }
    const result = await agentSessionManager.startSession({
      ...body.value,
      sessionId,
      ownerId: ownerScopeFromContext().id,
      sandbox,
    });
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ session: result.session }, result.status);
  });

  app.get("/api/sessions", async (c) => {
    const prRaw = c.req.query("pr");
    const limitRaw = c.req.query("limit");
    const result = await agentSessionManager.listSessions({
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
    const result = await agentSessionManager.getSession(c.req.param("sessionId"));
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ session: result.session });
  });

  app.post("/api/sessions/:sessionId/send", limited, async (c) => {
    const body = await parseJson(c, SendSessionInputSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const result = await agentSessionManager.sendInput(c.req.param("sessionId"), body.value.input);
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ session: result.session });
  });

  app.post("/api/sessions/:sessionId/observe", limited, async (c) => {
    const body = await parseJson(c, EmptyObjectSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const session = await agentSessionManager.getSession(c.req.param("sessionId"));
    if (!session.ok) return c.json({ error: session.error }, status(session.status));
    const result = sessionRuntimeBridge.registerSession(session.session, { mode: "observe" });
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json(result);
  });

  app.post("/api/sessions/:sessionId/takeover", limited, async (c) => {
    const body = await parseJson(c, EmptyObjectSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const session = await agentSessionManager.getSession(c.req.param("sessionId"));
    if (!session.ok) return c.json({ error: session.error }, status(session.status));
    const result = sessionRuntimeBridge.registerSession(session.session, { mode: "owner" });
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json(result);
  });

  app.delete("/api/sessions/:sessionId", limited, async (c) => {
    const body = await parseJson(c, EmptyObjectSchema);
    if (!body.ok) return c.json(errorBody(body.code, body.message), status(body.status));
    const result = await agentSessionManager.killSession(c.req.param("sessionId"));
    if (!result.ok) return c.json({ error: result.error }, status(result.status));
    return c.json({ session: result.session });
  });

  app.get("/api/agents", async (c) => c.json(await agentLauncher.detectAgents()));

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
    const review = createReviewLoopRecord({
      id: `rev_${randomUUID()}`,
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
