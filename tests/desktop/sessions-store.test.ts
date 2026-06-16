import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@desktop/shared/app-error";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { useBoard, type Card } from "@desktop/renderer/src/stores/board";
import { useSessions } from "@desktop/renderer/src/stores/sessions";

function makeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    baseUrl: "https://x.test",
    get: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
    getText: vi.fn().mockResolvedValue(""),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({ ok: true }),
    putText: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as ApiClient;
}

beforeEach(() => {
  useSessions.setState({ sessions: [], aliasMap: {}, loading: false, creating: false, error: null });
  useBoard.setState({
    projects: [],
    activeProjectSlug: null,
    cardsByProject: {},
    firstLoadByProject: {},
    refreshing: false,
    error: null,
  });
});

describe("useSessions.load", () => {
  it("ignores stale slower load results after a newer load finishes", async () => {
    let resolveFirstTerminal!: (value: { sessions: unknown[] }) => void;
    let resolveFirstWorkspace!: (value: { sessions: unknown[]; nextCursor: null }) => void;
    const firstTerminal = new Promise<{ sessions: unknown[] }>((resolve) => {
      resolveFirstTerminal = resolve;
    });
    const firstWorkspace = new Promise<{ sessions: unknown[]; nextCursor: null }>((resolve) => {
      resolveFirstWorkspace = resolve;
    });
    let call = 0;
    const get = vi.fn((path: string) => {
      call += 1;
      if (call === 1) return firstTerminal;
      if (call === 2) return firstWorkspace;
      if (path === "/api/terminal/sessions") {
        return Promise.resolve({ sessions: [{ name: "new-session", status: "active" }] });
      }
      return Promise.resolve({ sessions: [], nextCursor: null });
    });
    const api = makeApi({ get });

    const staleLoad = useSessions.getState().load(api);
    const freshLoad = useSessions.getState().load(api);
    await freshLoad;

    resolveFirstTerminal({ sessions: [{ name: "old-session", status: "active" }] });
    resolveFirstWorkspace({ sessions: [], nextCursor: null });
    await staleLoad;

    expect(useSessions.getState().sessions.map((session) => session.attachName)).toEqual([
      "new-session",
    ]);
    expect(useSessions.getState().loading).toBe(false);
    expect(useSessions.getState().error).toBeNull();
  });
});

describe("useSessions.create", () => {
  it("POSTs the session, reloads, and resolves the new attach name", async () => {
    const post = vi.fn().mockResolvedValue({ session: { id: "sess_new" } });
    // After creation, the reload returns the workspace session carrying its
    // zellij attach name so the merged aliasMap can resolve it.
    const get = vi.fn(async (path: string) => {
      if (path === "/api/terminal/sessions") return { sessions: [{ name: "matrix-task-9", status: "active" }] };
      return { sessions: [{ id: "sess_new", runtime: { zellijSession: "matrix-task-9" } }], nextCursor: null };
    });
    const api = makeApi({ post, get });

    const created = await useSessions.getState().create(api, {
      kind: "agent",
      agent: "claude",
      projectSlug: "proj",
      taskId: "task_a",
      prompt: "Fix the failing auth tests",
    });

    expect(post).toHaveBeenCalledWith("/api/sessions", {
      kind: "agent",
      agent: "claude",
      projectSlug: "proj",
      taskId: "task_a",
      prompt: "Fix the failing auth tests",
    });
    expect(created).toEqual({ sessionId: "sess_new", attachName: "matrix-task-9" });
    expect(useSessions.getState().creating).toBe(false);
    expect(useSessions.getState().error).toBeNull();
  });

  it("returns a null attach name when the new session has no zellij runtime yet", async () => {
    const post = vi.fn().mockResolvedValue({ session: { id: "sess_orch" } });
    const get = vi.fn(async (path: string) => {
      if (path === "/api/terminal/sessions") return { sessions: [] };
      return { sessions: [{ id: "sess_orch", runtime: {} }], nextCursor: null };
    });
    const api = makeApi({ post, get });
    const created = await useSessions.getState().create(api, { kind: "shell", taskId: "task_a" });
    expect(created).toEqual({ sessionId: "sess_orch", attachName: null });
  });

  it("deletes a workspace session when the post-create refresh fails", async () => {
    const post = vi.fn().mockResolvedValue({ session: { id: "sess_orphan" } });
    const get = vi.fn().mockRejectedValue(new AppError("offline"));
    const del = vi.fn().mockResolvedValue({ ok: true });
    const api = makeApi({ post, get, delete: del });

    const created = await useSessions.getState().create(api, { kind: "shell", taskId: "task_a" });

    expect(created).toBeNull();
    expect(del).toHaveBeenCalledWith("/api/sessions/sess_orphan");
    expect(useSessions.getState().creating).toBe(false);
    expect(useSessions.getState().error).toBe("offline");
  });

  it("uses the create response attach name when the reload has not indexed the alias yet", async () => {
    const post = vi.fn().mockResolvedValue({
      session: { id: "sess_new", runtime: { zellijSession: "matrix-task-new" } },
    });
    const get = vi.fn(async (path: string) => {
      if (path === "/api/terminal/sessions") return { sessions: [] };
      return { sessions: [], nextCursor: null };
    });
    const api = makeApi({ post, get });

    const created = await useSessions.getState().create(api, { kind: "shell", taskId: "task_a" });

    expect(created).toEqual({ sessionId: "sess_new", attachName: "matrix-task-new" });
  });

  it("surfaces an error category and clears the creating flag on failure", async () => {
    const api = makeApi({ post: vi.fn().mockRejectedValue(new AppError("offline")) });
    const created = await useSessions.getState().create(api, { kind: "shell", taskId: "task_a" });
    expect(created).toBeNull();
    expect(useSessions.getState().creating).toBe(false);
    expect(useSessions.getState().error).toBe("offline");
  });
});

describe("useSessions.restart", () => {
  it("deletes a restarted workspace session when the refresh fails", async () => {
    useSessions.setState({
      sessions: [
        {
          name: "task shell",
          attachName: "matrix-task-old",
          status: "active",
          source: "workspace",
          kind: "shell",
        },
      ],
    });
    const post = vi.fn().mockResolvedValue({ session: { id: "sess_restart" } });
    const get = vi.fn().mockRejectedValue(new AppError("offline"));
    const del = vi.fn().mockResolvedValue({ ok: true });
    const api = makeApi({ post, get, delete: del });

    const restarted = await useSessions.getState().restart(api, "matrix-task-old");

    expect(restarted).toBeNull();
    expect(del).toHaveBeenCalledWith("/api/terminal/sessions/matrix-task-old?force=1");
    expect(del).toHaveBeenCalledWith("/api/sessions/sess_restart");
    expect(useSessions.getState().creating).toBe(false);
    expect(useSessions.getState().error).toBe("offline");
  });
});

describe("useSessions.kill", () => {
  it("DELETEs the zellij session by name (forced) and reloads", async () => {
    const del = vi.fn().mockResolvedValue({ ok: true });
    const get = vi.fn().mockResolvedValue({ sessions: [], nextCursor: null });
    const api = makeApi({ delete: del, get });
    const ok = await useSessions.getState().kill(api, "matrix-task-1");
    expect(ok).toBe(true);
    expect(del).toHaveBeenCalledWith("/api/terminal/sessions/matrix-task-1?force=1");
    expect(get).toHaveBeenCalled(); // reload
  });

  it("encodes unsafe session names in the delete path", async () => {
    const del = vi.fn().mockResolvedValue({ ok: true });
    const api = makeApi({ delete: del });
    await useSessions.getState().kill(api, "weird/name");
    expect(del).toHaveBeenCalledWith("/api/terminal/sessions/weird%2Fname?force=1");
  });

  it("returns false and records an error category on failure", async () => {
    const api = makeApi({ delete: vi.fn().mockRejectedValue(new AppError("server")) });
    const ok = await useSessions.getState().kill(api, "matrix-task-1");
    expect(ok).toBe(false);
    expect(useSessions.getState().error).toBe("server");
  });
});

describe("useSessions.restart", () => {
  it("recreates the same zellij session name and reloads", async () => {
    const del = vi.fn().mockResolvedValue({ ok: true });
    const post = vi.fn().mockResolvedValue({ name: "matrix-task-1", created: true });
    const get = vi.fn().mockResolvedValue({ sessions: [], nextCursor: null });
    const api = makeApi({ delete: del, post, get });

    const restarted = await useSessions.getState().restart(api, "matrix-task-1");

    expect(del).toHaveBeenCalledWith("/api/terminal/sessions/matrix-task-1?force=1");
    expect(post).toHaveBeenCalledWith("/api/terminal/sessions", { name: "matrix-task-1" });
    expect(get).toHaveBeenCalled();
    expect(restarted).toEqual({ sessionId: "matrix-task-1", attachName: "matrix-task-1" });
    expect(useSessions.getState().creating).toBe(false);
    expect(useSessions.getState().error).toBeNull();
  });

  it("continues when the old session is already gone", async () => {
    const del = vi.fn().mockRejectedValue(new AppError("notFound"));
    const post = vi.fn().mockResolvedValue({ name: "matrix-task-1", created: true });
    const api = makeApi({ delete: del, post });

    const restarted = await useSessions.getState().restart(api, "matrix-task-1");

    expect(restarted?.attachName).toBe("matrix-task-1");
    expect(post).toHaveBeenCalledWith("/api/terminal/sessions", { name: "matrix-task-1" });
  });

  it("restarts workspace agent sessions through the session orchestrator", async () => {
    const card: Card = {
      id: "task_a",
      projectSlug: "proj",
      title: "Review",
      description: "",
      status: "running",
      priority: "normal",
      order: 1,
      parentTaskId: null,
      linkedSessionId: "sess_old",
      linkedWorktreeId: "wt_1",
      previewIds: [],
      tags: [],
      updatedAt: null,
      revision: 1,
    };
    useBoard.setState({ cardsByProject: { proj: [card] } });
    useSessions.setState({
      sessions: [
        {
          name: "Review",
          attachName: "matrix-agent-1",
          status: "exited",
          source: "workspace",
          kind: "agent",
          agent: "codex",
          projectSlug: "proj",
          taskId: "task_a",
          worktreeId: "wt_1",
        },
      ],
      aliasMap: { sess_old: "matrix-agent-1" },
    });
    const del = vi.fn().mockResolvedValue({ ok: true });
    const post = vi.fn().mockResolvedValue({
      session: { id: "sess_next", runtime: { zellijSession: "matrix-agent-2" } },
    });
    const get = vi.fn().mockResolvedValue({ sessions: [], nextCursor: null });
    const patch = vi.fn().mockResolvedValue({
      task: { ...card, linkedSessionId: "sess_next" },
    });
    const api = makeApi({ delete: del, post, get, patch });

    const restarted = await useSessions.getState().restart(api, "matrix-agent-1");

    expect(del).toHaveBeenCalledWith("/api/terminal/sessions/matrix-agent-1?force=1");
    expect(post).toHaveBeenCalledWith("/api/sessions", {
      kind: "agent",
      agent: "codex",
      projectSlug: "proj",
      taskId: "task_a",
      worktreeId: "wt_1",
    });
    expect(patch).toHaveBeenCalledWith("/api/projects/proj/tasks/task_a", {
      linkedSessionId: "sess_next",
    });
    expect(restarted).toEqual({ sessionId: "sess_next", attachName: "matrix-agent-2" });
  });

  it("cleans up the restarted workspace session when relinking the task fails", async () => {
    const card: Card = {
      id: "task_a",
      projectSlug: "proj",
      title: "Review",
      description: "",
      status: "running",
      priority: "normal",
      order: 1,
      parentTaskId: null,
      linkedSessionId: "sess_old",
      linkedWorktreeId: "wt_1",
      previewIds: [],
      tags: [],
      updatedAt: null,
      revision: 1,
    };
    useBoard.setState({ cardsByProject: { proj: [card] } });
    useSessions.setState({
      sessions: [
        {
          name: "Review",
          attachName: "matrix-agent-1",
          status: "exited",
          source: "workspace",
          kind: "agent",
          agent: "codex",
          projectSlug: "proj",
          taskId: "task_a",
          worktreeId: "wt_1",
        },
      ],
      aliasMap: { sess_old: "matrix-agent-1" },
    });
    const del = vi.fn().mockResolvedValue({ ok: true });
    const api = makeApi({
      delete: del,
      post: vi.fn().mockResolvedValue({
        session: { id: "sess_next", runtime: { zellijSession: "matrix-agent-2" } },
      }),
      get: vi.fn().mockResolvedValue({ sessions: [], nextCursor: null }),
      patch: vi.fn().mockRejectedValue(new AppError("offline")),
    });

    const restarted = await useSessions.getState().restart(api, "matrix-agent-1");

    expect(restarted).toBeNull();
    expect(del).toHaveBeenCalledWith("/api/terminal/sessions/matrix-agent-1?force=1");
    expect(del).toHaveBeenCalledWith("/api/terminal/sessions/matrix-agent-2?force=1");
    expect(useSessions.getState().creating).toBe(false);
    expect(useSessions.getState().error).toBe("offline");
  });
});
