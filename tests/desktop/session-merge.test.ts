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

  function makeApi(get: ReturnType<typeof vi.fn>): ApiClient {
    return {
      baseUrl: "https://x.test",
      get,
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      putText: vi.fn(),
    } as ApiClient;
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
});
