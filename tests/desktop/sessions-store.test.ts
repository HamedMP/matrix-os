import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@desktop/shared/app-error";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { useSessions } from "@desktop/renderer/src/stores/sessions";

const WORKSPACE_ID = `tws_${"a".repeat(32)}`;
const TAB_ID = `tt_${"b".repeat(32)}`;
const NEW_TAB_ID = `tt_${"c".repeat(32)}`;
const REF = `${WORKSPACE_ID}:${TAB_ID}`;
const NEW_REF = `${WORKSPACE_ID}:${NEW_TAB_ID}`;

function terminalWorkspaces(tabId = TAB_ID, name = "shell") {
  return { workspaces: [{ id: WORKSPACE_ID, projectId: "project_matrix", tabs: [{ id: tabId, name, cwd: "projects/matrix-os", status: "running" }] }] };
}

function makeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    baseUrl: "https://x.test",
    get: vi.fn(async (path: string) => path === "/api/terminal/workspaces" ? terminalWorkspaces() : { sessions: [], nextCursor: null }),
    getText: vi.fn().mockResolvedValue(""),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    put: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({ ok: true }),
    putText: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as ApiClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  useSessions.setState(useSessions.getInitialState(), true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("useSessions TerminalRef integration", () => {
  it("loads workspace tabs and merges coding-agent aliases", async () => {
    const get = vi.fn(async (path: string) => path === "/api/terminal/workspaces"
      ? terminalWorkspaces()
      : {
          sessions: [{
            id: "sess_agent",
            kind: "agent",
            agent: "codex",
            runtime: { terminalRef: { workspaceId: WORKSPACE_ID, tabId: TAB_ID }, status: "running" },
          }],
          nextCursor: null,
        });
    await useSessions.getState().load(makeApi({ get }));

    expect(get).toHaveBeenCalledWith("/api/terminal/workspaces");
    expect(get).toHaveBeenCalledWith("/api/sessions");
    expect(useSessions.getState().sessions).toEqual([expect.objectContaining({ attachName: REF, kind: "agent", agent: "codex" })]);
    expect(useSessions.getState().resolveAttachName("sess_agent")).toBe(REF);
  });

  it("ignores a stale load after a newer workspace snapshot wins", async () => {
    const staleTerminal = deferred<ReturnType<typeof terminalWorkspaces>>();
    let terminalCalls = 0;
    const get = vi.fn(async (path: string) => {
      if (path === "/api/sessions") return { sessions: [], nextCursor: null };
      terminalCalls += 1;
      return terminalCalls === 1 ? staleTerminal.promise : terminalWorkspaces(NEW_TAB_ID, "fresh");
    });
    const api = makeApi({ get });
    const first = useSessions.getState().load(api);
    await useSessions.getState().load(api);
    staleTerminal.resolve(terminalWorkspaces(TAB_ID, "stale"));
    await first;
    expect(useSessions.getState().sessions.map((entry) => entry.attachName)).toEqual([NEW_REF]);
  });

  it("creates a standalone tab through ensure and returns its stable ref", async () => {
    const post = vi.fn(async (path: string) => path.endsWith("/ensure")
      ? { workspace: { id: WORKSPACE_ID } }
      : { tab: { id: NEW_TAB_ID } });
    const get = vi.fn(async (path: string) => path === "/api/terminal/workspaces"
      ? terminalWorkspaces(NEW_TAB_ID, "swift-falcon")
      : { sessions: [], nextCursor: null });

    const created = await useSessions.getState().create(makeApi({ post, get }));

    expect(post).toHaveBeenNthCalledWith(1, "/api/terminal/workspaces/ensure", {});
    expect(post).toHaveBeenNthCalledWith(2, `/api/terminal/workspaces/${WORKSPACE_ID}/tabs`, expect.objectContaining({ cwd: "projects" }));
    expect(created).toEqual({ sessionId: NEW_REF, attachName: NEW_REF });
  });

  it("uses a coding-agent response TerminalRef as the direct attach identity", async () => {
    const post = vi.fn().mockResolvedValue({
      session: { id: "sess_agent", runtime: { terminalRef: { workspaceId: WORKSPACE_ID, tabId: TAB_ID } } },
    });
    const get = vi.fn(async (path: string) => path === "/api/terminal/workspaces"
      ? terminalWorkspaces()
      : { sessions: [], nextCursor: null });
    const input = { kind: "agent" as const, agent: "codex" as const, projectSlug: "matrix-os" };

    await expect(useSessions.getState().create(makeApi({ post, get }), input)).resolves.toEqual({
      sessionId: "sess_agent",
      attachName: REF,
    });
    expect(post).toHaveBeenCalledWith("/api/sessions", input);
  });

  it("terminates one tab by stable IDs and refreshes without killing its workspace", async () => {
    useSessions.setState({ sessions: [{ name: "shell", attachName: REF, status: "active", source: "terminal-tab" }] });
    const del = vi.fn().mockResolvedValue({ ok: true });
    const get = vi.fn(async (path: string) => path === "/api/terminal/workspaces"
      ? { workspaces: [] }
      : { sessions: [], nextCursor: null });

    await expect(useSessions.getState().kill(makeApi({ delete: del, get }), REF)).resolves.toBe(true);
    expect(del).toHaveBeenCalledWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs/${TAB_ID}`);
  });

  it("rejects legacy attach names without issuing a delete", async () => {
    const del = vi.fn();
    await expect(useSessions.getState().kill(makeApi({ delete: del }), "main")).resolves.toBe(false);
    expect(del).not.toHaveBeenCalled();
    expect(useSessions.getState().error).toBe("server");
  });

  it("restarts a standalone tab inside the same workspace", async () => {
    useSessions.setState({ sessions: [{ name: "shell", attachName: REF, status: "active", source: "terminal-tab" }] });
    const del = vi.fn().mockResolvedValue({ ok: true });
    const post = vi.fn().mockResolvedValue({ tab: { id: NEW_TAB_ID } });
    const get = vi.fn(async (path: string) => path === "/api/terminal/workspaces"
      ? terminalWorkspaces(NEW_TAB_ID, "replacement")
      : { sessions: [], nextCursor: null });

    await expect(useSessions.getState().restart(makeApi({ delete: del, post, get }), REF)).resolves.toEqual({
      sessionId: NEW_REF,
      attachName: NEW_REF,
    });
    expect(post).toHaveBeenCalledWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs`, expect.objectContaining({ cwd: "projects" }));
  });

  it("surfaces bounded client error state when workspace creation fails", async () => {
    const post = vi.fn().mockRejectedValue(new AppError("offline"));
    await expect(useSessions.getState().create(makeApi({ post }))).resolves.toBeNull();
    expect(useSessions.getState()).toMatchObject({ creating: false, error: "offline" });
  });
});
