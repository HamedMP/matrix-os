import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@desktop/shared/app-error";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { advanceRuntimeGeneration } from "@desktop/renderer/src/stores/runtime-generation";
import { isValidShellSessionName, useShellSessions } from "@desktop/renderer/src/stores/shell-sessions";

function makeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    baseUrl: "https://x.test",
    get: vi.fn().mockResolvedValue({ sessions: [] }),
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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  useShellSessions.setState(useShellSessions.getInitialState(), true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useShellSessions", () => {
  it("validates shell names with gateway-compatible boundaries", () => {
    expect(isValidShellSessionName("m")).toBe(true);
    expect(isValidShellSessionName("matrix-1")).toBe(true);
    expect(isValidShellSessionName("matrix-")).toBe(false);
    expect(isValidShellSessionName("-matrix")).toBe(false);
    expect(isValidShellSessionName("Matrix")).toBe(false);
    expect(isValidShellSessionName("matrix_shell")).toBe(false);
    expect(isValidShellSessionName("a".repeat(31))).toBe(true);
    expect(isValidShellSessionName("a".repeat(32))).toBe(false);
  });

  it("loads only canonical shell sessions from /api/terminal/sessions", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/terminal/sessions") {
        return {
          sessions: [
            {
              name: "matrix-main",
              status: "active",
              placement: "active",
              updatedAt: "2026-06-23T12:00:00.000Z",
              attachedClients: 1,
              latestSeq: 3,
              lastSeenSeq: 2,
              unread: true,
              visualStatus: "running",
              attachCommand: "matrix shell connect matrix-main",
              tabs: [{ idx: 0, name: "main", focused: true }],
            },
          ],
        };
      }
      if (path === "/api/sessions") {
        return { sessions: [{ id: "workspace-only", runtime: { zellijSession: "matrix-agent-1" } }] };
      }
      return { sessions: [] };
    });

    await useShellSessions.getState().load(makeApi({ get }));

    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith("/api/terminal/sessions");
    expect(useShellSessions.getState().sessions.map((session) => session.name)).toEqual(["matrix-main"]);
    expect(useShellSessions.getState().sessions[0]?.tabs).toEqual([{ idx: 0, name: "main", focused: true }]);
  });

  it("ignores stale load results with a resettable store sequence", async () => {
    const staleResponse = deferred<{ sessions: Array<{ name: string }> }>();
    const get = vi
      .fn()
      .mockReturnValueOnce(staleResponse.promise)
      .mockResolvedValueOnce({ sessions: [{ name: "matrix-fresh" }] });

    const staleLoad = useShellSessions.getState().load(makeApi({ get }));
    await useShellSessions.getState().load(makeApi({ get }));
    staleResponse.resolve({ sessions: [{ name: "matrix-stale" }] });
    await staleLoad;

    expect(useShellSessions.getState().sessions.map((session) => session.name)).toEqual(["matrix-fresh"]);

    useShellSessions.setState(useShellSessions.getInitialState(), true);
    await useShellSessions.getState().load(makeApi({
      get: vi.fn().mockResolvedValue({ sessions: [{ name: "matrix-reset" }] }),
    }));

    expect(useShellSessions.getState().sessions.map((session) => session.name)).toEqual(["matrix-reset"]);
  });

  it("creates shell sessions with matrix names, projects cwd, and retries one 409 conflict", async () => {
    const post = vi
      .fn()
      .mockRejectedValueOnce(new AppError("server", { detail: "session_exists" }))
      .mockResolvedValueOnce({ name: "matrix-created" });
    const get = vi.fn().mockResolvedValue({ sessions: [{ name: "matrix-created", status: "active" }] });

    const created = await useShellSessions.getState().create(makeApi({ post, get }));

    expect(created?.name).toBe("matrix-created");
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenNthCalledWith(1, "/api/terminal/sessions", {
      name: expect.stringMatching(/^matrix-[a-z0-9]{7}$/),
      cwd: "projects",
    });
    expect(post).toHaveBeenNthCalledWith(2, "/api/terminal/sessions", {
      name: expect.stringMatching(/^matrix-[a-z0-9]{7}$/),
      cwd: "projects",
    });
    expect(useShellSessions.getState().sessions.map((session) => session.name)).toEqual(["matrix-created"]);
  });

  it("keeps a created shell when an older load resolves after create refresh", async () => {
    const staleLoad = deferred<{ sessions: Array<{ name: string }> }>();
    const get = vi
      .fn()
      .mockReturnValueOnce(staleLoad.promise)
      .mockResolvedValueOnce({ sessions: [{ name: "matrix-created", status: "active" }] });
    const post = vi.fn().mockResolvedValue({ name: "matrix-created" });

    const initialLoad = useShellSessions.getState().load(makeApi({ get }));
    const created = await useShellSessions.getState().create(makeApi({ get, post }));
    staleLoad.resolve({ sessions: [{ name: "matrix-stale", status: "active" }] });
    await initialLoad;

    expect(created?.name).toBe("matrix-created");
    expect(useShellSessions.getState().sessions.map((session) => session.name)).toEqual(["matrix-created"]);
  });

  it("deletes shell sessions with force and rolls back when deletion fails", async () => {
    useShellSessions.setState({
      sessions: [
        { name: "matrix-main", status: "active" },
        { name: "matrix-build", status: "active" },
      ],
    });
    const del = vi.fn().mockRejectedValue(new AppError("offline"));

    const ok = await useShellSessions.getState().deleteSession(makeApi({ delete: del }), "matrix-main");

    expect(ok).toBe(false);
    expect(del).toHaveBeenCalledWith("/api/terminal/sessions/matrix-main?force=1");
    expect(useShellSessions.getState().sessions.map((session) => session.name)).toEqual(["matrix-main", "matrix-build"]);
  });

  it("renames via /rename and rolls back optimistic state on failure", async () => {
    useShellSessions.setState({
      sessions: [
        { name: "matrix-main", status: "active", attachCommand: "matrix shell connect matrix-main" },
      ],
    });
    const put = vi.fn().mockRejectedValue(new AppError("server"));

    const ok = await useShellSessions.getState().rename(makeApi({ put }), "matrix-main", "matrix-dev");

    expect(ok).toBe(false);
    expect(put).toHaveBeenCalledWith("/api/terminal/sessions/matrix-main/rename", { name: "matrix-dev" });
    expect(useShellSessions.getState().sessions[0]).toMatchObject({
      name: "matrix-main",
      attachCommand: "matrix shell connect matrix-main",
    });
  });

  it("reorders through /order and rolls back optimistic order on failure", async () => {
    useShellSessions.setState({
      sessions: [
        { name: "matrix-one", status: "active", placement: "active" },
        { name: "matrix-two", status: "active", placement: "active" },
      ],
    });
    const put = vi.fn().mockRejectedValue(new AppError("offline"));

    const ok = await useShellSessions.getState().reorder(makeApi({ put }), "matrix-one", "matrix-two");

    expect(ok).toBe(false);
    expect(put).toHaveBeenCalledWith("/api/terminal/sessions/order", { order: ["matrix-two", "matrix-one"] });
    expect(useShellSessions.getState().sessions.map((session) => session.name)).toEqual(["matrix-one", "matrix-two"]);
  });

  it("drops a reorder response that settles after a runtime switch", async () => {
    useShellSessions.setState({
      sessions: [
        { name: "matrix-one", status: "active", placement: "active" },
        { name: "matrix-two", status: "active", placement: "active" },
      ],
    });
    let resolvePut: (value: unknown) => void = () => undefined;
    const put = vi.fn(() => new Promise((resolve) => { resolvePut = resolve; }));

    const pending = useShellSessions.getState().reorder(makeApi({ put }), "matrix-one", "matrix-two");
    advanceRuntimeGeneration();
    useShellSessions.setState({ sessions: [] });
    resolvePut({ sessions: [
      { name: "matrix-one", status: "active" },
      { name: "matrix-two", status: "active" },
    ] });
    await pending;

    expect(useShellSessions.getState().sessions).toEqual([]);
  });

  it("patches /ui-state and rolls back optimistic placement on failure", async () => {
    useShellSessions.setState({
      sessions: [{ name: "matrix-main", status: "active", placement: "active", latestSeq: 5, lastSeenSeq: 1 }],
    });
    const patch = vi.fn().mockRejectedValue(new AppError("timeout"));

    const ok = await useShellSessions.getState().patchUiState(makeApi({ patch }), "matrix-main", {
      placement: "background",
      lastSeenSeq: 5,
    });

    expect(ok).toBe(false);
    expect(patch).toHaveBeenCalledWith("/api/terminal/sessions/matrix-main/ui-state", {
      placement: "background",
      lastSeenSeq: 5,
    });
    expect(useShellSessions.getState().sessions[0]).toMatchObject({
      placement: "active",
      lastSeenSeq: 1,
    });
  });

  it("does not undo another shell's successful placement when one placement rollback fails", async () => {
    useShellSessions.setState({
      sessions: [
        { name: "matrix-one", status: "active", placement: "active" },
        { name: "matrix-two", status: "active", placement: "active" },
      ],
    });
    const firstPatch = deferred<{ session?: unknown }>();
    const patch = vi.fn((path: string) => {
      if (path === "/api/terminal/sessions/matrix-one/ui-state") return firstPatch.promise;
      return Promise.resolve({ session: { name: "matrix-two", status: "active", placement: "background" } });
    });

    const firstMove = useShellSessions.getState().patchUiState(makeApi({ patch }), "matrix-one", {
      placement: "background",
    });
    const secondMove = await useShellSessions.getState().patchUiState(makeApi({ patch }), "matrix-two", {
      placement: "background",
    });
    firstPatch.reject(new AppError("timeout"));
    const firstOk = await firstMove;

    expect(firstOk).toBe(false);
    expect(secondMove).toBe(true);
    expect(useShellSessions.getState().sessions).toEqual([
      { name: "matrix-one", status: "active", placement: "active" },
      { name: "matrix-two", status: "active", placement: "background" },
    ]);
  });
});
