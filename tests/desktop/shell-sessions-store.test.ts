import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@desktop/shared/app-error";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { isValidShellSessionName, useShellSessions } from "@desktop/renderer/src/stores/shell-sessions";
import { advanceRuntimeGeneration } from "@desktop/renderer/src/stores/runtime-generation";

const WORKSPACE_ID = `tws_${"a".repeat(32)}`;
const TAB_ONE = `tt_${"1".repeat(32)}`;
const TAB_TWO = `tt_${"2".repeat(32)}`;
const REF_ONE = `${WORKSPACE_ID}:${TAB_ONE}`;
const REF_TWO = `${WORKSPACE_ID}:${TAB_TWO}`;

function tab(id: string, name: string, revision = 3) {
  return { id, name, cwd: "projects/matrix-os", status: "active", revision, placement: "active", lastSeenSeq: 2, latestSeq: 5 };
}

function workspaces(tabs = [tab(TAB_ONE, "build")], revision = 7) {
  return { workspaces: [{ id: WORKSPACE_ID, projectId: "project_matrix", revision, tabs }] };
}

function makeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    baseUrl: "https://x.test",
    get: vi.fn().mockResolvedValue(workspaces()),
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
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  useShellSessions.setState(useShellSessions.getInitialState(), true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("useShellSessions workspace/tab contract", () => {
  it("accepts only stable terminal ref keys", () => {
    expect(isValidShellSessionName(REF_ONE)).toBe(true);
    expect(isValidShellSessionName("main")).toBe(false);
    expect(isValidShellSessionName(`${WORKSPACE_ID}:legacy`)).toBe(false);
  });

  it("loads tabs from project workspaces with stable refs and unread state", async () => {
    const get = vi.fn().mockResolvedValue(workspaces([
      tab(TAB_ONE, "build"),
      { id: "legacy", name: "ignored" },
    ]));
    await useShellSessions.getState().load(makeApi({ get }));

    expect(get).toHaveBeenCalledWith("/api/terminal/workspaces");
    expect(useShellSessions.getState().sessions).toEqual([
      expect.objectContaining({
        name: REF_ONE,
        workspaceId: WORKSPACE_ID,
        tabId: TAB_ONE,
        subtitle: "build",
        projectId: "project_matrix",
        revision: 3,
        workspaceRevision: 7,
        unread: true,
        attachCommand: `matrix shell connect --project project_matrix --tab ${TAB_ONE}`,
      }),
    ]);
  });

  it("ignores a stale load that resolves after a newer workspace list", async () => {
    const slow = deferred<ReturnType<typeof workspaces>>();
    const get = vi.fn()
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce(workspaces([tab(TAB_TWO, "fresh")]));
    const api = makeApi({ get });
    const first = useShellSessions.getState().load(api);
    await useShellSessions.getState().load(api);
    slow.resolve(workspaces([tab(TAB_ONE, "stale")]));
    await first;
    expect(useShellSessions.getState().sessions.map((entry) => entry.name)).toEqual([REF_TWO]);
  });

  it("creates one tab in the ensured workspace and refreshes it", async () => {
    const post = vi.fn(async (path: string) => path.endsWith("/ensure")
      ? { workspace: { id: WORKSPACE_ID, revision: 7 } }
      : { tab: tab(TAB_TWO, "swift-falcon") });
    const get = vi.fn().mockResolvedValue(workspaces([tab(TAB_TWO, "swift-falcon")]));

    const created = await useShellSessions.getState().create(makeApi({ post, get }));

    expect(post).toHaveBeenNthCalledWith(1, "/api/terminal/workspaces/ensure", {});
    expect(post).toHaveBeenNthCalledWith(2, `/api/terminal/workspaces/${WORKSPACE_ID}/tabs`, expect.objectContaining({ cwd: "projects" }));
    expect(created).toMatchObject({ name: REF_TWO, tabId: TAB_TWO, workspaceId: WORKSPACE_ID });
  });

  it("terminates only the selected tab and restores it on failure", async () => {
    useShellSessions.setState({ sessions: [{
      name: REF_ONE, workspaceId: WORKSPACE_ID, tabId: TAB_ONE, revision: 3, workspaceRevision: 7, cwd: "projects", subtitle: "build",
    }] });
    const del = vi.fn().mockRejectedValue(new AppError("offline"));

    await expect(useShellSessions.getState().deleteSession(makeApi({ delete: del }), REF_ONE)).resolves.toBe(false);
    expect(del).toHaveBeenCalledWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs/${TAB_ONE}`);
    expect(useShellSessions.getState().sessions.map((entry) => entry.name)).toEqual([REF_ONE]);
    expect(useShellSessions.getState().error).toBe("offline");
  });

  it("renames by stable IDs with optimistic-concurrency revision and rolls back", async () => {
    useShellSessions.setState({ sessions: [{
      name: REF_ONE, workspaceId: WORKSPACE_ID, tabId: TAB_ONE, revision: 3, workspaceRevision: 7, cwd: "projects", subtitle: "build",
    }] });
    const patch = vi.fn().mockRejectedValue(new AppError("timeout"));

    await expect(useShellSessions.getState().rename(makeApi({ patch }), REF_ONE, "compile")).resolves.toBe(false);
    expect(patch).toHaveBeenCalledWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs/${TAB_ONE}`, {
      name: "compile",
      baseRevision: 3,
    });
    expect(useShellSessions.getState().sessions[0]?.subtitle).toBe("build");
  });

  it("reorders tabs within one workspace using tab IDs and workspace revision", async () => {
    useShellSessions.setState({ sessions: [
      { name: REF_ONE, workspaceId: WORKSPACE_ID, tabId: TAB_ONE, revision: 3, workspaceRevision: 7, cwd: "projects" },
      { name: REF_TWO, workspaceId: WORKSPACE_ID, tabId: TAB_TWO, revision: 4, workspaceRevision: 7, cwd: "projects" },
    ] });
    const put = vi.fn().mockResolvedValue({ workspace: {} });

    await expect(useShellSessions.getState().reorder(makeApi({ put }), REF_ONE, REF_TWO)).resolves.toBe(true);
    expect(put).toHaveBeenCalledWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs/order`, {
      tabIds: [TAB_TWO, TAB_ONE],
      baseRevision: 7,
    });
    expect(useShellSessions.getState().sessions.map((entry) => entry.name)).toEqual([REF_TWO, REF_ONE]);
  });

  it("drops a reorder response that settles after a runtime switch", async () => {
    useShellSessions.setState({ sessions: [
      { name: REF_ONE, workspaceId: WORKSPACE_ID, tabId: TAB_ONE, revision: 3, workspaceRevision: 7, cwd: "projects" },
      { name: REF_TWO, workspaceId: WORKSPACE_ID, tabId: TAB_TWO, revision: 4, workspaceRevision: 7, cwd: "projects" },
    ] });
    const pending = deferred<{ workspace: unknown }>();
    const reorder = useShellSessions.getState().reorder(makeApi({
      put: vi.fn(() => pending.promise),
    }), REF_ONE, REF_TWO);

    advanceRuntimeGeneration();
    useShellSessions.setState(useShellSessions.getInitialState(), true);
    pending.reject(new AppError("offline"));

    await expect(reorder).resolves.toBe(false);
    expect(useShellSessions.getState().sessions).toEqual([]);
    expect(useShellSessions.getState().error).toBeNull();
  });

  it("patches tab UI state by stable IDs and rolls back an optimistic failure", async () => {
    useShellSessions.setState({ sessions: [{
      name: REF_ONE, workspaceId: WORKSPACE_ID, tabId: TAB_ONE, revision: 3, workspaceRevision: 7, cwd: "projects", placement: "active",
    }] });
    const patch = vi.fn().mockRejectedValue(new AppError("timeout"));

    await expect(useShellSessions.getState().patchUiState(makeApi({ patch }), REF_ONE, { placement: "background" })).resolves.toBe(false);
    expect(patch).toHaveBeenCalledWith(`/api/terminal/workspaces/${WORKSPACE_ID}/tabs/${TAB_ONE}/ui-state`, {
      placement: "background",
      baseRevision: 3,
    });
    expect(useShellSessions.getState().sessions[0]?.placement).toBe("active");
  });
});
