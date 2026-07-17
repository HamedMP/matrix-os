import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@desktop/shared/app-error";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import {
  mergeAttachableSessions,
  type WorkspaceSessionDTO,
  type ZellijSessionDTO,
} from "@desktop/renderer/src/lib/session-merge";
import { useSessions } from "@desktop/renderer/src/stores/sessions";

describe("mergeAttachableSessions", () => {
  it("returns empty result for empty inputs", () => {
    expect(mergeAttachableSessions([], [])).toEqual({ sessions: [], aliasMap: {} });
  });

  it("makes every zellij entry with a non-empty name attachable by name", () => {
    const zellij: ZellijSessionDTO[] = [
      { name: "main", status: "active" },
      { name: "old", status: "exited" },
    ];
    const { sessions, aliasMap } = mergeAttachableSessions(zellij, []);
    expect(sessions).toEqual([
      { name: "main", attachName: "main", status: "active", source: "zellij" },
      { name: "old", attachName: "old", status: "exited", source: "zellij" },
    ]);
    expect(aliasMap["main"]).toBe("main");
    expect(aliasMap["old"]).toBe("old");
  });

  it("skips zellij entries with empty names", () => {
    const { sessions, aliasMap } = mergeAttachableSessions([{ name: "" }, { name: "   " }], []);
    expect(sessions).toEqual([]);
    expect(aliasMap).toEqual({});
  });

  it("defaults zellij status to active when missing", () => {
    const { sessions } = mergeAttachableSessions([{ name: "main" }], []);
    expect(sessions[0]!.status).toBe("active");
  });

  it("makes workspace records attachable only when runtime.zellijSession is non-empty", () => {
    const workspace: WorkspaceSessionDTO[] = [
      { id: "sess_aaa", runtime: { zellijSession: "matrix-sess-aaa" } },
      { id: "sess_bbb", runtime: { zellijSession: "" } },
      { id: "sess_ccc", runtime: {} },
      { id: "sess_ddd", runtime: null },
      { id: "sess_eee" },
    ];
    const { sessions } = mergeAttachableSessions([], workspace);
    expect(sessions).toEqual([
      {
        name: "matrix-sess-aaa",
        attachName: "matrix-sess-aaa",
        status: "active",
        source: "workspace",
      },
    ]);
  });

  it("never exposes orchestrator UUIDs as attach targets", () => {
    const workspace: WorkspaceSessionDTO[] = [
      { id: "9b2f8c3e-1d4a-4f6b-8e2a-7c5d9e0f1a2b", runtime: null },
      { sessionId: "sess_orchestrator", runtime: { zellijSession: null } },
    ];
    const { sessions, aliasMap } = mergeAttachableSessions([], workspace);
    expect(sessions).toEqual([]);
    expect(aliasMap).toEqual({});
  });

  it("maps every identifier of an attachable workspace record to the attach name", () => {
    const workspace: WorkspaceSessionDTO[] = [
      {
        id: "sess_abc123",
        sessionId: "sess_alias456",
        name: "fix-login-bug",
        runtime: { zellijSession: "matrix-sess-abc" },
      },
    ];
    const { aliasMap } = mergeAttachableSessions([], workspace);
    expect(aliasMap["sess_abc123"]).toBe("matrix-sess-abc");
    expect(aliasMap["sess_alias456"]).toBe("matrix-sess-abc");
    expect(aliasMap["fix-login-bug"]).toBe("matrix-sess-abc");
    expect(aliasMap["matrix-sess-abc"]).toBe("matrix-sess-abc");
  });

  it("uses the workspace record name for display when present", () => {
    const { sessions } = mergeAttachableSessions(
      [],
      [{ id: "sess_x", name: "review-pr", runtime: { zellijSession: "matrix-sess-x" } }],
    );
    expect(sessions[0]).toEqual({
      name: "review-pr",
      attachName: "matrix-sess-x",
      status: "active",
      source: "workspace",
    });
  });

  it("maps exited and failed workspace statuses to exited", () => {
    const { sessions } = mergeAttachableSessions(
      [],
      [
        { id: "sess_1", status: "exited", runtime: { zellijSession: "z1" } },
        { id: "sess_2", status: "failed", runtime: { zellijSession: "z2" } },
        { id: "sess_3", status: "running", runtime: { zellijSession: "z3" } },
      ],
    );
    expect(sessions.map((s) => s.status)).toEqual(["exited", "exited", "active"]);
  });

  it("dedupes workspace records against zellij entries with zellij status winning", () => {
    const zellij: ZellijSessionDTO[] = [{ name: "matrix-sess-abc", status: "active" }];
    const workspace: WorkspaceSessionDTO[] = [
      { id: "sess_abc123", status: "exited", runtime: { zellijSession: "matrix-sess-abc" } },
    ];
    const { sessions, aliasMap } = mergeAttachableSessions(zellij, workspace);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual({
      name: "matrix-sess-abc",
      attachName: "matrix-sess-abc",
      status: "active",
      source: "zellij",
    });
    expect(aliasMap["sess_abc123"]).toBe("matrix-sess-abc");
  });

  it("carries agent/kind/runtime status from a workspace record", () => {
    const { sessions } = mergeAttachableSessions(
      [],
      [
        {
          id: "sess_a",
          kind: "agent",
          agent: "claude",
          projectSlug: "proj",
          taskId: "task_a",
          worktreeId: "wt_1",
          runtime: { zellijSession: "z1", status: "waiting" },
        },
      ],
    );
    expect(sessions[0]).toMatchObject({
      attachName: "z1",
      kind: "agent",
      agent: "claude",
      projectSlug: "proj",
      taskId: "task_a",
      worktreeId: "wt_1",
      runtimeStatus: "waiting",
    });
  });

  it("enriches a zellij-sourced session with workspace agent metadata (zellij status still wins)", () => {
    const { sessions } = mergeAttachableSessions(
      [{ name: "z1", status: "active" }],
      [{ id: "sess_a", kind: "agent", agent: "codex", runtime: { zellijSession: "z1", status: "running" } }],
    );
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ attachName: "z1", source: "zellij", status: "active", kind: "agent", agent: "codex", runtimeStatus: "running" });
  });

  it("omits metadata for a plain workspace shell (minimal shape preserved)", () => {
    const { sessions } = mergeAttachableSessions([], [{ id: "sess_s", runtime: { zellijSession: "z2" } }]);
    expect(sessions[0]).toEqual({ name: "z2", attachName: "z2", status: "active", source: "workspace" });
  });

  it("dedupes two workspace records sharing one zellij session, keeping all aliases", () => {
    const workspace: WorkspaceSessionDTO[] = [
      { id: "sess_first", runtime: { zellijSession: "shared" } },
      { id: "sess_second", runtime: { zellijSession: "shared" } },
    ];
    const { sessions, aliasMap } = mergeAttachableSessions([], workspace);
    expect(sessions).toHaveLength(1);
    expect(aliasMap["sess_first"]).toBe("shared");
    expect(aliasMap["sess_second"]).toBe("shared");
  });
});

describe("useSessions store", () => {
  beforeEach(() => {
    useSessions.setState(useSessions.getInitialState(), true);
  });

  function makeApi(get: ReturnType<typeof vi.fn>, post: ReturnType<typeof vi.fn> = vi.fn()): ApiClient {
    return {
      baseUrl: "https://x.test",
      get,
      post,
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      putText: vi.fn(),
    } as ApiClient;
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it("loads both routes and merges into attachable sessions", async () => {
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === "/api/terminal/sessions") {
        return Promise.resolve({ sessions: [{ name: "main", status: "active" }] });
      }
      if (path === "/api/sessions") {
        return Promise.resolve({
          sessions: [
            { id: "sess_abc", runtime: { type: "zellij", status: "running", zellijSession: "matrix-sess-abc" } },
            { id: "sess_orphan", runtime: { type: "pty", status: "running" } },
          ],
          nextCursor: null,
        });
      }
      return Promise.reject(new AppError("notFound"));
    });
    await useSessions.getState().load(makeApi(get));

    const state = useSessions.getState();
    expect(get).toHaveBeenCalledWith("/api/terminal/sessions");
    expect(get).toHaveBeenCalledWith("/api/sessions");
    expect(state.sessions.map((s) => s.attachName)).toEqual(["main", "matrix-sess-abc"]);
    expect(state.resolveAttachName("sess_abc")).toBe("matrix-sess-abc");
    expect(state.resolveAttachName("sess_orphan")).toBeNull();
    expect(state.resolveAttachName(null)).toBeNull();
    expect(state.error).toBeNull();
  });

  it("keeps previous sessions and sets an error category when a fetch fails", async () => {
    const ok = vi.fn().mockImplementation((path: string) =>
      path === "/api/terminal/sessions"
        ? Promise.resolve({ sessions: [{ name: "main", status: "active" }] })
        : Promise.resolve({ sessions: [], nextCursor: null }),
    );
    await useSessions.getState().load(makeApi(ok));

    const bad = vi.fn().mockRejectedValue(new AppError("offline"));
    await useSessions.getState().load(makeApi(bad));

    expect(useSessions.getState().sessions.map((s) => s.attachName)).toEqual(["main"]);
    expect(useSessions.getState().error).toBe("offline");
  });

  it("ignores stale slower load results after a newer load finishes", async () => {
    const firstTerminal = deferred<{ sessions: unknown[] }>();
    const firstWorkspace = deferred<{ sessions: unknown[]; nextCursor: null }>();
    let call = 0;
    const get = vi.fn((path: string) => {
      call += 1;
      if (call === 1 && path === "/api/terminal/sessions") return firstTerminal.promise;
      if (call === 2 && path === "/api/sessions") return firstWorkspace.promise;
      if (path === "/api/terminal/sessions") {
        return Promise.resolve({ sessions: [{ name: "new-session", status: "active" }] });
      }
      return Promise.resolve({ sessions: [], nextCursor: null });
    });

    const staleLoad = useSessions.getState().load(makeApi(get));
    const freshLoad = useSessions.getState().load(makeApi(get));
    await freshLoad;

    firstTerminal.resolve({ sessions: [{ name: "old-session", status: "active" }] });
    firstWorkspace.resolve({ sessions: [], nextCursor: null });
    await staleLoad;

    expect(useSessions.getState().sessions.map((session) => session.attachName)).toEqual([
      "new-session",
    ]);
    expect(useSessions.getState().loading).toBe(false);
    expect(useSessions.getState().error).toBeNull();
  });

  it("clears a stale load error while a refresh is pending", async () => {
    let resolveTerminal: ((value: { sessions: unknown[] }) => void) | null = null;
    const terminal = new Promise<{ sessions: unknown[] }>((resolve) => {
      resolveTerminal = resolve;
    });
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === "/api/terminal/sessions") {
        return terminal;
      }
      return Promise.resolve({ sessions: [], nextCursor: null });
    });

    useSessions.setState({ error: "offline" });
    const load = useSessions.getState().load(makeApi(get));

    expect(useSessions.getState().loading).toBe(true);
    expect(useSessions.getState().error).toBeNull();

    resolveTerminal?.({ sessions: [] });
    await load;
  });

  it("creates a terminal session and selects the attachable result", async () => {
    const get = vi.fn().mockImplementation((path: string) => {
      if (path === "/api/terminal/sessions") {
        return Promise.resolve({ sessions: [{ name: "operator-new", status: "active" }] });
      }
      return Promise.resolve({ sessions: [], nextCursor: null });
    });
    const post = vi.fn().mockResolvedValue({ name: "operator-new", created: true });

    const created = await useSessions.getState().create(makeApi(get, post));

    expect(post).toHaveBeenCalledWith("/api/terminal/sessions", {
      name: expect.stringMatching(/^[a-z]+-[a-z]+$/),
    });
    expect(created?.attachName).toBe("operator-new");
    expect(useSessions.getState().sessions.map((s) => s.attachName)).toEqual(["operator-new"]);
    expect(useSessions.getState().error).toBeNull();
  });

  it("clears a stale session error while create is pending", async () => {
    const created = deferred<{ name: string; created: true }>();
    const get = vi.fn().mockResolvedValue({ sessions: [], nextCursor: null });
    const post = vi.fn().mockReturnValue(created.promise);

    useSessions.setState({ error: "offline" });
    const create = useSessions.getState().create(makeApi(get, post));

    expect(useSessions.getState().creating).toBe(true);
    expect(useSessions.getState().error).toBeNull();

    created.resolve({ name: "operator-new", created: true });
    await create;
  });

  it("keeps the created session visible and preserves refresh errors after create", async () => {
    const get = vi.fn().mockRejectedValue(new AppError("offline"));
    const post = vi.fn().mockResolvedValue({ name: "operator-new", created: true });

    const created = await useSessions.getState().create(makeApi(get, post));

    expect(created?.attachName).toBe("operator-new");
    expect(useSessions.getState().sessions.map((s) => s.attachName)).toEqual(["operator-new"]);
    expect(useSessions.getState().error).toBe("offline");
  });

  it("keeps a superseding load in progress after create refresh is preempted", async () => {
    const internalTerminal = deferred<{ sessions: unknown[] }>();
    const internalWorkspace = deferred<{ sessions: unknown[]; nextCursor: null }>();
    const competingTerminal = new Promise<{ sessions: unknown[] }>(() => undefined);
    const competingWorkspace = new Promise<{ sessions: unknown[]; nextCursor: null }>(() => undefined);
    const post = vi.fn().mockResolvedValue({ name: "operator-new", created: true });
    let call = 0;
    const get = vi.fn((path: string) => {
      call += 1;
      if (call === 1 && path === "/api/terminal/sessions") return internalTerminal.promise;
      if (call === 2 && path === "/api/sessions") return internalWorkspace.promise;
      if (path === "/api/terminal/sessions") return competingTerminal;
      return competingWorkspace;
    });

    const createPromise = useSessions.getState().create(makeApi(get, post));
    while (call < 2) {
      await Promise.resolve();
    }
    void useSessions.getState().load(makeApi(get));
    expect(useSessions.getState().loading).toBe(true);

    internalTerminal.resolve({ sessions: [{ name: "operator-new", status: "active" }] });
    internalWorkspace.resolve({ sessions: [], nextCursor: null });

    await expect(createPromise).resolves.toMatchObject({ attachName: "operator-new" });
    expect(useSessions.getState().loading).toBe(true);
  });
});
