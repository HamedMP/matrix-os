import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceRoutes } from "../../packages/gateway/src/workspace-routes.js";

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

  it("routes GitHub status and worktree creation through injected managers", async () => {
    const projectManager = {
      getGithubStatus: vi.fn(async () => ({ installed: true, authenticated: true, user: "octocat", errorCode: null })),
      createProject: vi.fn(),
      listManagedProjects: vi.fn(),
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
    const res = await app.request(jsonRequest("/api/projects/repo/worktrees", { branch: "main" }));
    expect(res.status).toBe(201);
    expect(worktreeManager.createWorktree).toHaveBeenCalledWith({ projectSlug: "repo", branch: "main" });
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
      ownerId: "local",
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
});
