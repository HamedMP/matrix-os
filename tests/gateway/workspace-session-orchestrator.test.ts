import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { createWorkspaceSessionOrchestrator } from "../../packages/gateway/src/workspace-session-orchestrator.js";

describe("workspace session orchestrator", () => {
  const homePath = "/matrix/home";
  const worktree = {
    id: "wt_abc123def456",
    projectSlug: "repo",
    path: join(homePath, "projects", "repo", "worktrees", "wt_abc123def456"),
  };
  const session = {
    id: "sess_fixed",
    kind: "agent",
    projectSlug: "repo",
    taskId: "task_abc123",
    worktreeId: "wt_abc123def456",
    agent: "codex",
    runtime: { type: "zellij", status: "running" },
    terminalSessionId: "term_sess_fixed",
  };

  function deps(overrides: Record<string, unknown> = {}) {
    const worktreeManager = {
      listWorktrees: vi.fn(async () => ({ ok: true, worktrees: [worktree] })),
    };
    const agentSandbox = {
      preflight: vi.fn(async () => ({
        ok: true,
        sandbox: { enabled: true, writableRoots: [worktree.path] },
        sandboxStatus: { available: true },
      })),
    };
    const agentSessionManager = {
      startSession: vi.fn(async () => ({ ok: true, status: 201, session })),
      listSessions: vi.fn(async () => ({ ok: true, sessions: [session], nextCursor: null })),
      getSession: vi.fn(async () => ({ ok: true, session })),
      sendInput: vi.fn(async () => ({ ok: true, session })),
      killSession: vi.fn(async () => ({ ok: true, session: { ...session, runtime: { type: "zellij", status: "exited" } } })),
    };
    const sessionRuntimeBridge = {
      registerSession: vi.fn(() => ({ ok: true, mode: "observe", terminalSessionId: "term_sess_fixed" })),
    };
    const eventPublisher = {
      publishSessionStarted: vi.fn(async () => undefined),
    };
    return {
      worktreeManager,
      agentSandbox,
      agentSessionManager,
      sessionRuntimeBridge,
      eventPublisher,
      ...overrides,
    };
  }

  it("starts codex sessions with sandbox preflight, owner scope, and a session event", async () => {
    const d = deps();
    const orchestrator = createWorkspaceSessionOrchestrator({
      ...d,
      idGenerator: () => "sess_fixed",
    });

    const result = await orchestrator.startSession({
      ownerScope: { type: "user", id: "user_workspace" },
      request: {
        projectSlug: "repo",
        taskId: "task_abc123",
        worktreeId: "wt_abc123def456",
        kind: "agent",
        agent: "codex",
        prompt: "fix tests",
      },
    });

    expect(result).toMatchObject({ ok: true, status: 201, session: { id: "sess_fixed" } });
    expect(d.worktreeManager.listWorktrees).toHaveBeenCalledWith("repo");
    expect(d.agentSandbox.preflight).toHaveBeenCalledWith({
      agent: "codex",
      sessionId: "sess_fixed",
      worktreePath: worktree.path,
      adminOverride: undefined,
    });
    expect(d.agentSessionManager.startSession).toHaveBeenCalledWith(expect.objectContaining({
      agent: "codex",
      ownerId: "user_workspace",
      sandbox: { enabled: true, writableRoots: [worktree.path] },
      sessionId: "sess_fixed",
    }));
    expect(d.eventPublisher.publishSessionStarted).toHaveBeenCalledWith(session);
  });

  it("returns a safe sandbox failure before launching a session", async () => {
    const d = deps({
      agentSandbox: {
        preflight: vi.fn(async () => ({
          ok: false,
          status: 400,
          error: { code: "sandbox_unavailable", message: "Agent sandbox is unavailable" },
          sandboxStatus: { available: false },
        })),
      },
    });
    const orchestrator = createWorkspaceSessionOrchestrator({
      ...d,
      idGenerator: () => "sess_fixed",
    });

    const result = await orchestrator.startSession({
      ownerScope: { type: "user", id: "user_workspace" },
      request: {
        projectSlug: "repo",
        worktreeId: "wt_abc123def456",
        kind: "agent",
        agent: "codex",
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      error: { code: "sandbox_unavailable", message: "Agent sandbox is unavailable" },
      sandboxStatus: { available: false },
    });
    expect(d.agentSessionManager.startSession).not.toHaveBeenCalled();
    expect(d.eventPublisher.publishSessionStarted).not.toHaveBeenCalled();
  });

  it("returns not found when the requested worktree is missing", async () => {
    const d = deps({
      worktreeManager: {
        listWorktrees: vi.fn(async () => ({ ok: true, worktrees: [] })),
      },
    });
    const orchestrator = createWorkspaceSessionOrchestrator({
      ...d,
      idGenerator: () => "sess_fixed",
    });

    const result = await orchestrator.startSession({
      ownerScope: { type: "user", id: "user_workspace" },
      request: {
        projectSlug: "repo",
        worktreeId: "wt_abc123def456",
        kind: "agent",
        agent: "codex",
      },
    });

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: { code: "not_found", message: "Worktree was not found" },
    });
    expect(d.agentSandbox.preflight).not.toHaveBeenCalled();
    expect(d.agentSessionManager.startSession).not.toHaveBeenCalled();
  });

  it("delegates attach, list, send, and stop operations through one lifecycle interface", async () => {
    const d = deps();
    const orchestrator = createWorkspaceSessionOrchestrator({ ...d });

    await expect(orchestrator.listSessions({ projectSlug: "repo", limit: 10 })).resolves.toMatchObject({
      ok: true,
      sessions: [expect.objectContaining({ id: "sess_fixed" })],
    });
    await expect(orchestrator.sendInput("sess_fixed", "pnpm test\n")).resolves.toMatchObject({
      ok: true,
      session: expect.objectContaining({ id: "sess_fixed" }),
    });
    await expect(orchestrator.attachSession("sess_fixed", "observe")).resolves.toMatchObject({
      ok: true,
      terminalSessionId: "term_sess_fixed",
    });
    await expect(orchestrator.stopSession("sess_fixed")).resolves.toMatchObject({
      ok: true,
      session: expect.objectContaining({ id: "sess_fixed" }),
    });
    expect(d.sessionRuntimeBridge.registerSession).toHaveBeenCalledWith(session, { mode: "observe" });
  });
});
