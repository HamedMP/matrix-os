import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceRoutes } from "../../packages/gateway/src/workspace-routes.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteJsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchJsonRequest(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("workspace API routes", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-workspace-routes-"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns structured generic validation errors for project creation", async () => {
    const app = createWorkspaceRoutes({ homePath });

    const res = await app.request(jsonRequest("/api/projects", { url: "https://example.com/not/github" }));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "invalid_repository_url",
        message: "Repository URL must point to GitHub",
      },
    });
  });

  it("applies body limits to mutating workspace routes", async () => {
    const app = createWorkspaceRoutes({ homePath });
    const res = await app.request(jsonRequest("/api/projects", { url: "github.com/owner/repo", padding: "x".repeat(70 * 1024) }));

    expect(res.status).toBe(413);
  });

  it("rejects invalid workspace delete slugs before state deletion", async () => {
    await mkdir(join(homePath, "projects", "keep"), { recursive: true });
    const app = createWorkspaceRoutes({ homePath });

    const res = await app.request(deleteJsonRequest("/api/workspace/data", {
      scope: "project",
      projectSlug: "",
      confirmation: "delete project workspace data",
    }));

    expect(res.status).toBe(400);
    await expect(stat(join(homePath, "projects", "keep"))).resolves.toMatchObject({ isDirectory: expect.any(Function) });
  });

  it("routes GitHub status and worktree creation through injected managers", async () => {
    const projectManager = {
      getGithubStatus: vi.fn(async () => ({ installed: true, authenticated: true, user: "octocat", errorCode: null })),
      createProject: vi.fn(),
      listManagedProjects: vi.fn(async () => ({ projects: [{ slug: "repo", name: "Repo" }] })),
      getProject: vi.fn(),
      deleteProject: vi.fn(),
      listPullRequests: vi.fn(),
      listBranches: vi.fn(),
    };
    const worktreeManager = {
      createWorktree: vi.fn(async () => ({ ok: true, status: 201, worktree: { id: "wt_abc", projectSlug: "repo" } })),
      listWorktrees: vi.fn(),
      deleteWorktree: vi.fn(),
    };
    const app = createWorkspaceRoutes({ homePath, projectManager, worktreeManager });

    await expect((await app.request("/api/github/status")).json()).resolves.toEqual({
      installed: true,
      authenticated: true,
      user: "octocat",
      errorCode: null,
    });
    await expect((await app.request("/api/workspace/projects")).json()).resolves.toEqual({
      projects: [{ slug: "repo", name: "Repo" }],
    });
    expect(projectManager.listManagedProjects).toHaveBeenCalled();
    const res = await app.request(jsonRequest("/api/projects/repo/worktrees", { branch: "main" }));
    expect(res.status).toBe(201);
    expect(worktreeManager.createWorktree).toHaveBeenCalledWith({ projectSlug: "repo", branch: "main" });
  });

  it("derives project owner scope from the injected principal owner scope", async () => {
    const projectManager = {
      getGithubStatus: vi.fn(),
      createProject: vi.fn(async () => ({ ok: true, status: 201, project: { slug: "repo" } })),
      listManagedProjects: vi.fn(),
      getProject: vi.fn(),
      deleteProject: vi.fn(),
      listPullRequests: vi.fn(),
      listBranches: vi.fn(),
    };
    const app = createWorkspaceRoutes({
      homePath,
      projectManager,
      getOwnerScope: () => ({ type: "user", id: "user_workspace" }),
    });

    const res = await app.request(jsonRequest("/api/projects", { url: "github.com/owner/repo", ownerScope: { type: "user", id: "attacker" } }));

    expect(res.status).toBe(201);
    expect(projectManager.createProject).toHaveBeenCalledWith({
      url: "github.com/owner/repo",
      slug: undefined,
      ownerScope: { type: "user", id: "user_workspace" },
    });
  });

  it("returns unauthorized before creating workspace data when no principal is available", async () => {
    const projectManager = {
      getGithubStatus: vi.fn(),
      createProject: vi.fn(),
      listManagedProjects: vi.fn(),
      getProject: vi.fn(),
      deleteProject: vi.fn(),
      listPullRequests: vi.fn(),
      listBranches: vi.fn(),
    };
    const app = createWorkspaceRoutes({
      homePath,
      projectManager,
      getOwnerScope: () => {
        throw new MissingRequestPrincipalError();
      },
    });

    const res = await app.request(jsonRequest("/api/projects", { url: "github.com/owner/repo" }));

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: { code: "unauthorized", message: "Unauthorized" } });
    expect(projectManager.createProject).not.toHaveBeenCalled();
  });

  it("routes session lifecycle, observe, takeover, and sandbox status through injected managers", async () => {
    const session = {
      id: "sess_abc123",
      runtime: { type: "zellij", status: "running", zellijSession: "matrix-sess_abc123" },
      terminalSessionId: "term_sess_abc123",
      nativeAttachCommand: ["zellij", "attach", "matrix-sess_abc123"],
    };
    const projectManager = {
      getGithubStatus: vi.fn(),
      createProject: vi.fn(),
      listManagedProjects: vi.fn(),
      getProject: vi.fn(),
      deleteProject: vi.fn(),
      listPullRequests: vi.fn(),
      listBranches: vi.fn(),
    };
    const worktreeManager = {
      createWorktree: vi.fn(),
      listWorktrees: vi.fn(async () => ({
        ok: true,
        worktrees: [{ id: "wt_abc123def456", path: join(homePath, "projects", "repo", "worktrees", "wt_abc123def456") }],
      })),
      deleteWorktree: vi.fn(),
    };
    const agentSessionManager = {
      startSession: vi.fn(async () => ({ ok: true, status: 201, session })),
      listSessions: vi.fn(async () => ({ ok: true, sessions: [session], nextCursor: null })),
      getSession: vi.fn(async () => ({ ok: true, session })),
      sendInput: vi.fn(async () => ({ ok: true, session })),
      killSession: vi.fn(async () => ({ ok: true, session: { ...session, runtime: { ...session.runtime, status: "exited" } } })),
    };
    const agentLauncher = {
      detectAgents: vi.fn(async () => ({ agents: [{ id: "codex", installed: true, authState: "ok" }] })),
      buildLaunch: vi.fn(),
    };
    const agentSandbox = {
      preflight: vi.fn(async () => ({ ok: true, sandbox: { enabled: true, writableRoots: [homePath] }, status: { available: true } })),
      status: vi.fn(async () => ({ available: true, enforced: true, requiresAdminOverride: false, reason: "ok" })),
    };
    const sessionRuntimeBridge = {
      registerSession: vi.fn(() => ({ ok: true, mode: "observe", terminalSessionId: "550e8400-e29b-41d4-a716-446655440000" })),
    };
    const app = createWorkspaceRoutes({
      homePath,
      projectManager,
      worktreeManager,
      agentSessionManager,
      agentLauncher,
      agentSandbox,
      sessionRuntimeBridge,
      getOwnerScope: () => ({ type: "user", id: "user_workspace" }),
    });

    const created = await app.request(jsonRequest("/api/sessions", {
      projectSlug: "repo",
      worktreeId: "wt_abc123def456",
      kind: "agent",
      agent: "codex",
      prompt: "fix tests",
    }));
    expect(created.status).toBe(201);
    expect(agentSandbox.preflight).toHaveBeenCalled();
    expect(agentSessionManager.startSession).toHaveBeenCalledWith(expect.objectContaining({
      agent: "codex",
      ownerId: "user_workspace",
      sandbox: { enabled: true, writableRoots: [homePath] },
    }));

    await expect((await app.request("/api/sessions?projectSlug=repo&limit=10")).json()).resolves.toMatchObject({
      sessions: [expect.objectContaining({ id: "sess_abc123" })],
    });
    await expect((await app.request(jsonRequest("/api/sessions/sess_abc123/send", { input: "pnpm test\n" }))).json()).resolves.toMatchObject({
      session: expect.objectContaining({ id: "sess_abc123" }),
    });
    await expect((await app.request(jsonRequest("/api/sessions/sess_abc123/observe", {}))).json()).resolves.toMatchObject({
      terminalSessionId: "550e8400-e29b-41d4-a716-446655440000",
    });
    expect(sessionRuntimeBridge.registerSession).toHaveBeenCalledWith(expect.objectContaining({ id: "sess_abc123" }), { mode: "observe" });
    await expect((await app.request(deleteJsonRequest("/api/sessions/sess_abc123", {}))).json()).resolves.toMatchObject({
      session: expect.objectContaining({ id: "sess_abc123" }),
    });
    await expect((await app.request("/api/agents")).json()).resolves.toMatchObject({
      agents: [expect.objectContaining({ id: "codex" })],
    });
    await expect((await app.request("/api/agents/sandbox-status")).json()).resolves.toMatchObject({
      available: true,
      enforced: true,
    });
  });

  it("routes review start, status, next, approve, and stop through review records", async () => {
    const saved: unknown[] = [];
    const review = {
      id: "rev_abc123",
      projectSlug: "repo",
      worktreeId: "wt_abc123def456",
      pr: 42,
      status: "queued",
      round: 0,
      maxRounds: 5,
      reviewer: "claude",
      implementer: "codex",
      convergenceGate: "findings_only",
      verificationCommands: [],
      rounds: [],
      createdAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
    };
    const reviewStore = {
      saveReview: vi.fn(async (value: unknown) => {
        saved.push(value);
        return { ok: true };
      }),
      getReview: vi.fn(async () => ({ ok: true, review: saved.at(-1) ?? review })),
      listReviews: vi.fn(async () => ({ ok: true, reviews: [saved.at(-1) ?? review], nextCursor: null })),
    };
    const app = createWorkspaceRoutes({ homePath, reviewStore });

    const created = await app.request(jsonRequest("/api/reviews", {
      projectSlug: "repo",
      worktreeId: "wt_abc123def456",
      pr: 42,
      reviewer: "claude",
      implementer: "codex",
      maxRounds: 5,
      convergenceGate: "findings_only",
      verificationCommands: [],
    }));
    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      review: { id: expect.stringMatching(/^rev_/), status: "queued", round: 0 },
    });

    await expect((await app.request("/api/reviews/rev_abc123")).json()).resolves.toMatchObject({
      review: expect.objectContaining({ projectSlug: "repo" }),
    });
    await expect((await app.request(jsonRequest("/api/reviews/rev_abc123/next", {}))).json()).resolves.toMatchObject({
      review: expect.objectContaining({ status: "reviewing", round: 1 }),
    });
    await expect((await app.request(jsonRequest("/api/reviews/rev_abc123/stop", {}))).json()).resolves.toMatchObject({
      review: expect.objectContaining({ status: "stopped" }),
    });
    saved.push({ ...(saved.at(-1) ?? review), status: "stalled" });
    await expect((await app.request(jsonRequest("/api/reviews/rev_abc123/approve", {}))).json()).resolves.toMatchObject({
      review: expect.objectContaining({ status: "approved" }),
    });
  });

  it("routes task, preview, and workspace event APIs through workspace managers", async () => {
    const task = {
      id: "task_abc123",
      projectSlug: "repo",
      title: "Fix auth",
      status: "todo",
      priority: "high",
      order: 0,
      previewIds: [],
      createdAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
    };
    const preview = {
      id: "prev_abc123",
      projectSlug: "repo",
      taskId: "task_abc123",
      label: "Local app",
      url: "http://localhost:3000",
      lastStatus: "ok",
      displayPreference: "panel",
      createdAt: "2026-04-26T00:00:00.000Z",
      updatedAt: "2026-04-26T00:00:00.000Z",
    };
    const event = {
      id: "evt_abc123",
      scope: { projectSlug: "repo", taskId: "task_abc123" },
      type: "task.created",
      payload: { title: "Fix auth" },
      createdAt: "2026-04-26T00:00:00.000Z",
    };
    const taskManager = {
      createTask: vi.fn(async () => ({ ok: true, status: 201, task })),
      listTasks: vi.fn(async () => ({ ok: true, tasks: [task], nextCursor: null })),
      updateTask: vi.fn(async () => ({ ok: true, task: { ...task, status: "running" } })),
      deleteTask: vi.fn(async () => ({ ok: true })),
    };
    const previewManager = {
      createPreview: vi.fn(async () => ({ ok: true, status: 201, preview })),
      listPreviews: vi.fn(async () => ({ ok: true, previews: [preview], nextCursor: null })),
      updatePreview: vi.fn(async () => ({ ok: true, preview: { ...preview, label: "External app" } })),
      deletePreview: vi.fn(async () => ({ ok: true })),
      detectPreviewUrls: vi.fn(),
    };
    const eventStore = {
      publishEvent: vi.fn(async () => ({ ok: true, event })),
      listEvents: vi.fn(async () => ({ ok: true, events: [event], nextCursor: null })),
    };
    const app = createWorkspaceRoutes({ homePath, taskManager, previewManager, eventStore });

    const createdTask = await app.request(jsonRequest("/api/projects/repo/tasks", { title: "Fix auth", priority: "high" }));
    expect(createdTask.status).toBe(201);
    expect(taskManager.createTask).toHaveBeenCalledWith("repo", { title: "Fix auth", priority: "high" });
    expect(eventStore.publishEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "task.created" }));
    await expect((await app.request("/api/projects/repo/tasks?includeArchived=true")).json()).resolves.toMatchObject({
      tasks: [expect.objectContaining({ id: "task_abc123" })],
    });
    await expect((await app.request(patchJsonRequest("/api/projects/repo/tasks/task_abc123", { status: "running" }))).json()).resolves.toMatchObject({
      task: expect.objectContaining({ status: "running" }),
    });
    await expect((await app.request(deleteJsonRequest("/api/projects/repo/tasks/task_abc123", {}))).json()).resolves.toEqual({ ok: true });

    const createdPreview = await app.request(jsonRequest("/api/projects/repo/previews", {
      taskId: "task_abc123",
      label: "Local app",
      url: "http://localhost:3000",
    }));
    expect(createdPreview.status).toBe(201);
    expect(previewManager.createPreview).toHaveBeenCalledWith("repo", expect.objectContaining({ url: "http://localhost:3000" }));
    await expect((await app.request("/api/projects/repo/previews?taskId=task_abc123")).json()).resolves.toMatchObject({
      previews: [expect.objectContaining({ id: "prev_abc123" })],
    });
    await expect((await app.request(patchJsonRequest("/api/projects/repo/previews/prev_abc123", { label: "External app" }))).json()).resolves.toMatchObject({
      preview: expect.objectContaining({ label: "External app" }),
    });
    await expect((await app.request(deleteJsonRequest("/api/projects/repo/previews/prev_abc123", {}))).json()).resolves.toEqual({ ok: true });

    await expect((await app.request("/api/workspace/events?projectSlug=repo")).json()).resolves.toMatchObject({
      events: [expect.objectContaining({ type: "task.created" })],
    });
  });
});
