import { afterEach, describe, expect, it, vi } from "vitest";
import { access, mkdir, mkdtemp, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupExpiredRootChatWorkspaces,
  createWorkspaceSessionOrchestrator,
} from "../../packages/gateway/src/workspace-session-orchestrator.js";

describe("workspace session orchestrator", () => {
  const terminalRef = {
    workspaceId: "tws_00000000000000000000000000000001",
    tabId: "tt_00000000000000000000000000000001",
  };
  const tempHomes: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(tempHomes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });
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
    terminalRef,
  };

  function deps(overrides: Record<string, unknown> = {}) {
    const projectManager = {
      getProject: vi.fn(async () => ({
        ok: true,
        project: {
          slug: "repo",
          localPath: join(homePath, "projects", "repo", "repo"),
          ownerScope: { type: "user", id: "user_workspace" },
        },
      })),
    };
    const worktreeManager = {
      createWorktree: vi.fn(async () => ({ ok: true, status: 201 as const, worktree })),
      listWorktrees: vi.fn(async () => ({ ok: true, worktrees: [worktree] })),
    };
    const agentSandbox = {
      preflight: vi.fn(async () => ({
        ok: true,
        sandbox: { enabled: true, writableRoots: [worktree.path] },
        sandboxStatus: { available: true },
      })),
      cleanup: vi.fn(async () => undefined),
    };
    const agentSessionManager = {
      startSession: vi.fn(async () => ({ ok: true, status: 201, session })),
      listSessions: vi.fn(async () => ({ ok: true, sessions: [session], nextCursor: null })),
      getSession: vi.fn(async () => ({ ok: true, session })),
      sendInput: vi.fn(async () => ({ ok: true, session })),
      killSession: vi.fn(async () => ({ ok: true, session: { ...session, runtime: { type: "zellij", status: "exited" } } })),
    };
    const sessionRuntimeBridge = {
      registerSession: vi.fn(() => ({ ok: true, mode: "observe", terminalRef })),
    };
    const eventPublisher = {
      publishSessionStarted: vi.fn(async () => undefined),
      publishSessionStopped: vi.fn(async () => undefined),
    };
    return {
      projectManager,
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
    expect(d.worktreeManager.listWorktrees).toHaveBeenCalledWith("repo", {
      type: "user",
      id: "user_workspace",
    });
    expect(d.agentSandbox.preflight).toHaveBeenCalledWith({
      agent: "codex",
      sessionId: "sess_fixed",
      worktreePath: worktree.path,
      adminOverride: undefined,
      approvalPolicy: "never",
      sandboxMode: "workspace_write",
      mode: undefined,
    });
    expect(d.agentSessionManager.startSession).toHaveBeenCalledWith(expect.objectContaining({
      agent: "codex",
      ownerId: "user_workspace",
      sandbox: { enabled: true, mode: "workspace-write", writableRoots: [worktree.path] },
      sessionId: "sess_fixed",
    }));
    expect(d.agentSessionManager.startSession.mock.calls[0]?.[0].approvalPolicy).toBeUndefined();
    expect(d.eventPublisher.publishSessionStarted).toHaveBeenCalledWith(session);
  });

  it("runs an agent in the canonical project folder when no worktree is requested", async () => {
    const projectRoot = join(homePath, "projects", "repo", "repo");
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
        kind: "agent",
        agent: "codex",
        prompt: "fix tests",
      },
    });

    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(d.projectManager.getProject).toHaveBeenCalledWith("repo");
    expect(d.worktreeManager.createWorktree).not.toHaveBeenCalled();
    expect(d.worktreeManager.listWorktrees).not.toHaveBeenCalled();
    expect(d.agentSandbox.preflight).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess_fixed",
      worktreePath: projectRoot,
    }));
    expect(d.agentSessionManager.startSession).toHaveBeenCalledWith(expect.objectContaining({
      projectSlug: "repo",
      ownerId: "user_workspace",
    }));
    expect(d.agentSessionManager.startSession.mock.calls[0]?.[0].worktreeId).toBeUndefined();
  });

  it("runs a root Chat in a dedicated bounded workspace instead of rejecting it", async () => {
    const rootChatWorkspace = join(homePath, "temporary", "root-chat-workspaces", "sess_fixed");
    const d = deps();
    const orchestrator = createWorkspaceSessionOrchestrator({
      ...d,
      homePath,
      prepareRootChatWorkspace: vi.fn(async () => rootChatWorkspace),
      idGenerator: () => "sess_fixed",
    });

    const result = await orchestrator.startSession({
      ownerScope: { type: "user", id: "user_workspace" },
      request: {
        kind: "agent",
        agent: "codex",
        prompt: "answer without a project",
      },
    });

    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(d.projectManager.getProject).not.toHaveBeenCalled();
    expect(d.agentSandbox.preflight).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "sess_fixed",
      worktreePath: rootChatWorkspace,
    }));
    expect(d.agentSessionManager.startSession).toHaveBeenCalledWith(expect.objectContaining({
      workspaceRoot: rootChatWorkspace,
      ownerId: "user_workspace",
    }));
  });

  it("periodically protects every active root Chat status and stops the timer on close", async () => {
    vi.useFakeTimers();
    const d = deps();
    const sweepRootChatWorkspaces = vi.fn(async () => undefined);
    vi.mocked(d.agentSessionManager.listSessions).mockResolvedValue({
      ok: true,
      sessions: ["starting", "running", "idle", "waiting", "exited"].map((status) => ({
        ...session,
        id: `sess_${status}`,
        projectSlug: undefined,
        runtime: { ...session.runtime, status },
      })),
      nextCursor: null,
    });
    const orchestrator = createWorkspaceSessionOrchestrator({
      ...d,
      homePath,
      sweepRootChatWorkspaces,
      rootWorkspaceSweepIntervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweepRootChatWorkspaces).toHaveBeenCalledWith(new Set([
      "sess_starting",
      "sess_running",
      "sess_idle",
      "sess_waiting",
    ]));

    await orchestrator.close();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweepRootChatWorkspaces).toHaveBeenCalledTimes(1);
  });

  it("waits for an in-flight root Chat workspace sweep during close", async () => {
    vi.useFakeTimers();
    const d = deps();
    let finishSweep!: () => void;
    const sweepRootChatWorkspaces = vi.fn(() => new Promise<void>((resolve) => {
      finishSweep = resolve;
    }));
    const orchestrator = createWorkspaceSessionOrchestrator({
      ...d,
      homePath,
      sweepRootChatWorkspaces,
      rootWorkspaceSweepIntervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    let closed = false;
    const closing = orchestrator.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    finishSweep();
    await closing;
    expect(closed).toBe(true);
  });

  it("removes only expired inactive root Chat workspaces and skips symlinks", async () => {
    const home = await mkdtemp(join(tmpdir(), "matrix-root-chat-"));
    tempHomes.push(home);
    const root = join(home, "temporary", "root-chat-workspaces");
    const expired = join(root, "sess_expired");
    const active = join(root, "sess_active");
    const external = join(home, "external");
    const linked = join(root, "sess_linked");
    await mkdir(expired, { recursive: true });
    await mkdir(active);
    await mkdir(external);
    await symlink(external, linked);
    await utimes(expired, 1, 1);
    await utimes(active, 1, 1);

    await cleanupExpiredRootChatWorkspaces(
      home,
      new Set(["sess_active"]),
      { nowMs: 10_000, ttlMs: 1_000 },
    );

    await expect(access(expired)).rejects.toThrow();
    await expect(access(active)).resolves.toBeUndefined();
    await expect(access(linked)).resolves.toBeUndefined();
    await expect(access(external)).resolves.toBeUndefined();
  });

  it("rejects legacy local primary checkouts when the authenticated owner does not match", async () => {
    const d = deps({
      projectManager: {
        getProject: vi.fn(async () => ({
          ok: true,
          project: {
            slug: "repo",
            localPath: join(homePath, "projects", "repo", "repo"),
            ownerScope: { type: "user", id: "local" },
          },
        })),
      },
    });
    const orchestrator = createWorkspaceSessionOrchestrator({ ...d });

    const result = await orchestrator.startSession({
      ownerScope: { type: "user", id: "user_workspace" },
      request: { projectSlug: "repo", kind: "agent", agent: "codex" },
    });

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(d.agentSandbox.preflight).not.toHaveBeenCalled();
    expect(d.agentSessionManager.startSession).not.toHaveBeenCalled();
  });

  it("rejects a requested worktree when its project owner does not match", async () => {
    const listWorktrees = vi.fn(async (
      _projectSlug: string,
      ownerScope?: { type: "user" | "org"; id: string },
    ) => ownerScope?.id === "owner_a"
      ? { ok: true as const, worktrees: [worktree] }
      : { ok: false as const, status: 404, error: { code: "not_found", message: "Project was not found" } });
    const d = deps({ worktreeManager: { listWorktrees } });
    const orchestrator = createWorkspaceSessionOrchestrator({ ...d });

    const result = await orchestrator.startSession({
      ownerScope: { type: "user", id: "owner_b" },
      request: {
        projectSlug: "repo",
        worktreeId: worktree.id,
        kind: "agent",
        agent: "codex",
      },
    });

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(listWorktrees).toHaveBeenCalledWith("repo", { type: "user", id: "owner_b" });
    expect(d.agentSandbox.preflight).not.toHaveBeenCalled();
    expect(d.agentSessionManager.startSession).not.toHaveBeenCalled();
  });

  it("requires the persisted primary project owner type to match", async () => {
    const d = deps({
      projectManager: {
        getProject: vi.fn(async () => ({
          ok: true,
          project: {
            slug: "repo",
            localPath: join(homePath, "projects", "repo", "repo"),
            ownerScope: { type: "org", id: "user_workspace" },
          },
        })),
      },
    });
    const orchestrator = createWorkspaceSessionOrchestrator({ ...d });

    const result = await orchestrator.startSession({
      ownerScope: { type: "user", id: "user_workspace" },
      request: { projectSlug: "repo", kind: "agent", agent: "codex" },
    });

    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(d.agentSandbox.preflight).not.toHaveBeenCalled();
  });

  it("starts Claude sessions only after provider-specific sandbox preflight", async () => {
    const d = deps();
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
        agent: "claude",
        prompt: "fix tests",
        approvalPolicy: "on_request",
        sandboxMode: "workspace_write",
      },
    });

    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(d.agentSandbox.preflight).toHaveBeenCalledWith({
      agent: "claude",
      sessionId: "sess_fixed",
      worktreePath: worktree.path,
      adminOverride: undefined,
      approvalPolicy: "on-request",
      sandboxMode: "workspace_write",
      mode: undefined,
    });
    expect(d.agentSessionManager.startSession).toHaveBeenCalledWith(expect.objectContaining({
      agent: "claude",
      sandbox: { enabled: true, mode: "workspace-write", writableRoots: [worktree.path] },
    }));
  });

  it("uses one effective default approval policy for Claude preflight and launch", async () => {
    const d = deps();
    const orchestrator = createWorkspaceSessionOrchestrator({
      ...d,
      idGenerator: () => "sess_fixed",
    });

    await expect(orchestrator.startSession({
      ownerScope: { type: "user", id: "user_workspace" },
      request: {
        projectSlug: "repo",
        worktreeId: "wt_abc123def456",
        kind: "agent",
        agent: "claude",
      },
    })).resolves.toMatchObject({ ok: true, status: 201 });

    expect(d.agentSandbox.preflight).toHaveBeenCalledWith(expect.objectContaining({
      approvalPolicy: "on-request",
    }));
    expect(d.agentSessionManager.startSession).toHaveBeenCalledWith(expect.objectContaining({
      approvalPolicy: "on_request",
    }));
  });

  it("does not fail a started session when session event publication throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const d = deps({
      eventPublisher: {
        publishSessionStarted: vi.fn(async () => {
          throw new Error("event write failed");
        }),
        publishSessionStopped: vi.fn(async () => undefined),
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

    expect(result).toMatchObject({ ok: true, status: 201, session: { id: "sess_fixed" } });
    expect(warn).toHaveBeenCalledWith("[workspace-session-orchestrator] Failed to publish session start event:", "event write failed");
  });

  it("preserves full-access sandbox requests as Codex danger-full-access launches", async () => {
    const d = deps();
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
        sandboxMode: "full_access",
      },
    });

    expect(result).toMatchObject({ ok: true, status: 201 });
    expect(d.agentSessionManager.startSession).toHaveBeenCalledWith(expect.objectContaining({
      sandbox: { enabled: true, mode: "danger-full-access", writableRoots: [] },
    }));
  });

  it("keeps Claude review mode read-only when full access is also requested", async () => {
    const gitCommonDir = "/matrix/home/projects/repo/repo/.git";
    const readOnlySandbox = {
      enabled: true,
      mode: "read-only" as const,
      writableRoots: [],
      denyWriteRoots: [worktree.path, gitCommonDir],
    };
    const d = deps({
      agentSandbox: {
        preflight: vi.fn(async () => ({
          ok: true,
          sandbox: readOnlySandbox,
          sandboxStatus: { available: true },
        })),
        cleanup: vi.fn(async () => undefined),
      },
    });
    const orchestrator = createWorkspaceSessionOrchestrator({
      ...d,
      idGenerator: () => "sess_fixed",
    });

    await expect(orchestrator.startSession({
      ownerScope: { type: "user", id: "user_workspace" },
      request: {
        projectSlug: "repo",
        worktreeId: "wt_abc123def456",
        kind: "agent",
        agent: "claude",
        mode: "review",
        sandboxMode: "full_access",
      },
    })).resolves.toMatchObject({ ok: true, status: 201 });

    expect(d.agentSessionManager.startSession).toHaveBeenCalledWith(expect.objectContaining({
      sandbox: readOnlySandbox,
    }));
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
        cleanup: vi.fn(async () => undefined),
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

  it("cleans prepared scratch state when session startup fails", async () => {
    const d = deps({
      agentSessionManager: {
        ...deps().agentSessionManager,
        startSession: vi.fn(async () => ({
          ok: false,
          status: 503,
          error: { code: "runtime_unavailable", message: "Session runtime is unavailable" },
        })),
      },
    });
    const orchestrator = createWorkspaceSessionOrchestrator({
      ...d,
      idGenerator: () => "sess_fixed",
    });

    await expect(orchestrator.startSession({
      ownerScope: { type: "user", id: "user_workspace" },
      request: {
        projectSlug: "repo",
        worktreeId: "wt_abc123def456",
        kind: "agent",
        agent: "claude",
      },
    })).resolves.toMatchObject({ ok: false, status: 503 });

    expect(d.agentSandbox.cleanup).toHaveBeenCalledWith({ sessionId: "sess_fixed" });
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
      terminalRef,
    });
    await expect(orchestrator.stopSession("sess_fixed")).resolves.toMatchObject({
      ok: true,
      session: expect.objectContaining({ id: "sess_fixed" }),
    });
    expect(d.sessionRuntimeBridge.registerSession).toHaveBeenCalledWith(session, { mode: "observe" });
    expect(d.eventPublisher.publishSessionStopped).toHaveBeenCalledWith(expect.objectContaining({ id: "sess_fixed" }));
    expect(d.agentSandbox.cleanup).toHaveBeenCalledWith({ sessionId: "sess_fixed" });
  });

  it("recovers active sessions without relying on object method this binding", async () => {
    const d = deps();
    const orchestrator = createWorkspaceSessionOrchestrator({ ...d });
    const recoverSessions = orchestrator.recoverSessions;

    await expect(recoverSessions()).resolves.toMatchObject({
      ok: true,
      sessions: [expect.objectContaining({ id: "sess_fixed" })],
    });
    expect(d.agentSessionManager.listSessions).toHaveBeenCalledWith({ status: "running" });
  });
});
