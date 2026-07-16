import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@desktop/shared/app-error";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { useGit, type Worktree } from "@desktop/renderer/src/stores/git";
import { advanceRuntimeGeneration } from "@desktop/renderer/src/stores/runtime-generation";

const T1 = "2026-06-13T00:00:00.000Z";
const T2 = "2026-06-13T01:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    baseUrl: "https://x.test",
    get: vi.fn().mockResolvedValue({}),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({ ok: true }),
    putText: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as ApiClient;
}

type Routes = Record<string, unknown>;

// Dispatches GETs by path substring; values that are Errors reject.
function routedGet(routes: Routes) {
  return vi.fn(async (path: string) => {
    for (const [needle, value] of Object.entries(routes)) {
      if (path.includes(needle)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    throw new Error(`unmocked path: ${path}`);
  });
}

// Fixtures mirror the gateway wire item shapes:
// BranchSummary / PullRequestSummary (project-manager.ts),
// WorktreeRecord (worktree-manager.ts), PreviewRecord (preview-manager.ts).
function wireBranch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "main", current: true, default: true, ...overrides };
}

function wirePr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    title: "Fix things",
    author: "hamed",
    headRef: "fix/things",
    baseRef: "main",
    state: "OPEN",
    ...overrides,
  };
}

function wireWorktree(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "wt_abc123def456",
    projectSlug: "proj",
    path: "/home/matrix/worktrees/wt_abc123def456",
    sourceBranch: "main",
    currentBranch: "fix/things",
    dirtyState: "clean",
    createdAt: T1,
    ...overrides,
  };
}

function wirePreview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "prev_1",
    projectSlug: "proj",
    taskId: "task_a",
    label: "Dev server",
    url: "https://preview.test",
    lastStatus: "ok",
    displayPreference: "panel",
    createdAt: T1,
    updatedAt: T1,
    ...overrides,
  };
}

beforeEach(() => {
  useGit.setState(useGit.getInitialState(), true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadAll", () => {
  it("fetches branches, prs, and worktrees and populates state", async () => {
    const get = routedGet({
      "/branches": { branches: [wireBranch()], refreshedAt: T1 },
      "/prs": { prs: [wirePr()], refreshedAt: T2 },
      "/worktrees": { worktrees: [wireWorktree()] },
    });
    const api = makeApi({ get: get as never });

    await useGit.getState().loadAll(api, "proj");

    expect(get).toHaveBeenCalledWith("/api/projects/proj/branches");
    expect(get).toHaveBeenCalledWith("/api/projects/proj/prs");
    expect(get).toHaveBeenCalledWith("/api/projects/proj/worktrees");
    const state = useGit.getState();
    expect(state.branches).toEqual([{ name: "main", current: true, default: true }]);
    expect(state.prs).toEqual([
      { number: 7, title: "Fix things", author: "hamed", headRef: "fix/things", baseRef: "main", state: "OPEN" },
    ]);
    expect(state.worktrees).toEqual([
      {
        id: "wt_abc123def456",
        projectSlug: "proj",
        path: "/home/matrix/worktrees/wt_abc123def456",
        sourceBranch: "main",
        currentBranch: "fix/things",
        dirtyState: "clean",
        createdAt: T1,
      },
    ]);
    expect(state.refreshedAt).toBe(T2);
    expect(state.loading).toBe(false);
    expect(state.error).toBeNull();
  });

  it("sets loading without clearing existing surfaces while requests are in flight", async () => {
    const d = deferred<unknown>();
    const get = vi.fn((path: string) => {
      if (path.includes("/branches")) return d.promise;
      if (path.includes("/prs")) return Promise.resolve({ prs: [], refreshedAt: T1 });
      return Promise.resolve({ worktrees: [] });
    });
    const api = makeApi({ get: get as never });
    useGit.setState({
      branches: [{ name: "stale" }],
      prs: [wirePr({ number: 99 }) as never],
      worktrees: [wireWorktree({ id: "stale_wt" }) as never],
      refreshedAt: T2,
    });

    const pending = useGit.getState().loadAll(api, "proj");
    expect(useGit.getState().loading).toBe(true);
    expect(useGit.getState().branches).toEqual([{ name: "stale" }]);
    expect(useGit.getState().prs).toEqual([wirePr({ number: 99 })]);
    expect(useGit.getState().worktrees).toEqual([wireWorktree({ id: "stale_wt" })]);
    expect(useGit.getState().refreshedAt).toBe(T2);
    d.resolve({ branches: [], refreshedAt: T1 });
    await pending;
    expect(useGit.getState().loading).toBe(false);
  });

  it("ignores stale loadAll results when project switches resolve out of order", async () => {
    const projectABranches = deferred<unknown>();
    const projectAPrs = deferred<unknown>();
    const projectAWorktrees = deferred<unknown>();
    const get = vi.fn((path: string) => {
      if (path.includes("/api/projects/project-a/branches")) return projectABranches.promise;
      if (path.includes("/api/projects/project-a/prs")) return projectAPrs.promise;
      if (path.includes("/api/projects/project-a/worktrees")) return projectAWorktrees.promise;
      if (path.includes("/api/projects/project-b/branches")) {
        return Promise.resolve({ branches: [wireBranch({ name: "project-b-main" })], refreshedAt: T2 });
      }
      if (path.includes("/api/projects/project-b/prs")) {
        return Promise.resolve({ prs: [wirePr({ number: 22, title: "Project B" })], refreshedAt: T2 });
      }
      if (path.includes("/api/projects/project-b/worktrees")) {
        return Promise.resolve({ worktrees: [wireWorktree({ id: "wt_project_b", projectSlug: "project-b" })] });
      }
      throw new Error(`unmocked path: ${path}`);
    });
    const api = makeApi({ get: get as never });

    const stale = useGit.getState().loadAll(api, "project-a");
    const fresh = useGit.getState().loadAll(api, "project-b");
    await fresh;

    expect(useGit.getState().branches).toEqual([{ name: "project-b-main", current: true, default: true }]);
    expect(useGit.getState().prs).toEqual([
      {
        number: 22,
        title: "Project B",
        author: "hamed",
        headRef: "fix/things",
        baseRef: "main",
        state: "OPEN",
      },
    ]);
    expect(useGit.getState().worktrees).toEqual([
      {
        id: "wt_project_b",
        projectSlug: "project-b",
        path: "/home/matrix/worktrees/wt_abc123def456",
        sourceBranch: "main",
        currentBranch: "fix/things",
        dirtyState: "clean",
        createdAt: T1,
      },
    ]);

    projectABranches.resolve({ branches: [wireBranch({ name: "project-a-main" })], refreshedAt: T1 });
    projectAPrs.resolve({ prs: [wirePr({ number: 11, title: "Project A" })], refreshedAt: T1 });
    projectAWorktrees.resolve({ worktrees: [wireWorktree({ id: "wt_project_a", projectSlug: "project-a" })] });
    await stale;

    expect(useGit.getState().branches).toEqual([{ name: "project-b-main", current: true, default: true }]);
    expect(useGit.getState().prs[0]?.number).toBe(22);
    expect(useGit.getState().worktrees[0]?.projectSlug).toBe("project-b");
    expect(useGit.getState().loading).toBe(false);
  });

  it("keeps stale surfaces visible when refresh fails and updates the others", async () => {
    useGit.setState({ branches: [{ name: "previous" }] });
    const get = routedGet({
      "/branches": new AppError("offline"),
      "/prs": { prs: [wirePr()], refreshedAt: T1 },
      "/worktrees": { worktrees: [wireWorktree()] },
    });
    const api = makeApi({ get: get as never });

    await useGit.getState().loadAll(api, "proj");

    const state = useGit.getState();
    expect(state.branches).toEqual([{ name: "previous" }]);
    expect(state.prs).toHaveLength(1);
    expect(state.worktrees).toHaveLength(1);
    expect(state.error).toBe("offline");
    expect(state.loading).toBe(false);
  });

  it("surfaces the worst error category across failing surfaces", async () => {
    const get = routedGet({
      "/branches": new AppError("notFound"),
      "/prs": new AppError("unauthorized"),
      "/worktrees": { worktrees: [] },
    });
    const api = makeApi({ get: get as never });

    await useGit.getState().loadAll(api, "proj");

    expect(useGit.getState().error).toBe("unauthorized");
  });

  it("skips malformed rows with a warning and tolerates unknown extra fields", async () => {
    const get = routedGet({
      "/branches": {
        branches: [wireBranch({ upstream: "origin/main" }), { name: 42 }],
        refreshedAt: T1,
      },
      "/prs": { prs: [{ title: "missing number" }], refreshedAt: T1 },
      "/worktrees": { worktrees: [wireWorktree({ extra: { nested: true } })] },
    });
    const api = makeApi({ get: get as never });

    await useGit.getState().loadAll(api, "proj");

    const state = useGit.getState();
    expect(state.branches).toEqual([{ name: "main", current: true, default: true }]);
    expect(state.prs).toEqual([]);
    expect(state.worktrees).toHaveLength(1);
    expect(state.error).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe("loadPreviews", () => {
  it("loads previews for a project", async () => {
    const get = vi.fn().mockResolvedValue({ previews: [wirePreview()], nextCursor: null });
    const api = makeApi({ get: get as never });

    await useGit.getState().loadPreviews(api, "proj");

    expect(get).toHaveBeenCalledWith("/api/projects/proj/previews?limit=100");
    expect(useGit.getState().previews).toEqual([
      {
        id: "prev_1",
        projectSlug: "proj",
        taskId: "task_a",
        label: "Dev server",
        url: "https://preview.test",
        lastStatus: "ok",
        displayPreference: "panel",
        createdAt: T1,
        updatedAt: T1,
      },
    ]);
    expect(useGit.getState().previewError).toBeNull();
  });

  it("scopes previews by taskId via query param", async () => {
    const get = vi.fn().mockResolvedValue({ previews: [], nextCursor: null });
    const api = makeApi({ get: get as never });

    await useGit.getState().loadPreviews(api, "proj", "task_a");

    expect(get).toHaveBeenCalledWith("/api/projects/proj/previews?limit=100&taskId=task_a");
  });

  it("merges task-scoped previews without removing other task badges", async () => {
    useGit.setState({
      previews: [
        {
          ...wirePreview({ id: "prev_task_a", taskId: "task_a", label: "Task A" }),
          updatedAt: T1,
        },
        {
          ...wirePreview({ id: "prev_task_b", taskId: "task_b", label: "Task B" }),
          updatedAt: T1,
        },
      ],
    });
    const get = vi.fn().mockResolvedValue({
      previews: [wirePreview({ id: "prev_task_a", taskId: "task_a", label: "Task A refreshed" })],
      nextCursor: null,
    });
    const api = makeApi({ get: get as never });

    await useGit.getState().loadPreviews(api, "proj", "task_a");

    expect(Object.fromEntries(useGit.getState().previews.map((preview) => [preview.id, preview.label]))).toEqual({
      prev_task_a: "Task A refreshed",
      prev_task_b: "Task B",
    });
  });

  it("replaces stale preview records when a preview is reassigned into the loaded scope", async () => {
    useGit.setState({
      previews: [
        {
          ...wirePreview({ id: "prev_move", taskId: "task_b", label: "Old task" }),
          updatedAt: T1,
        },
      ],
    });
    const get = vi.fn().mockResolvedValue({
      previews: [wirePreview({ id: "prev_move", taskId: "task_a", label: "New task" })],
      nextCursor: null,
    });
    const api = makeApi({ get: get as never });

    await useGit.getState().loadPreviews(api, "proj", "task_a");

    expect(useGit.getState().previews).toMatchObject([
      { id: "prev_move", taskId: "task_a", label: "New task" },
    ]);
  });

  it("keeps existing previews and sets the error category on failure", async () => {
    const existing = {
      id: "prev_keep",
      projectSlug: "proj",
      label: "Keep",
      url: "https://keep.test",
      lastStatus: "unknown",
      displayPreference: "panel",
    };
    useGit.setState({ previews: [existing as never] });
    const get = vi.fn().mockRejectedValue(new AppError("timeout"));
    const api = makeApi({ get: get as never });

    await useGit.getState().loadPreviews(api, "proj");

    expect(useGit.getState().previews).toEqual([existing]);
    expect(useGit.getState().previewError).toBe("timeout");
  });

  it("keeps preview loads from clearing git list errors", async () => {
    useGit.setState({ error: "unauthorized" });
    const get = vi.fn().mockResolvedValue({ previews: [wirePreview()], nextCursor: null });
    const api = makeApi({ get: get as never });

    await useGit.getState().loadPreviews(api, "proj");

    expect(useGit.getState().error).toBe("unauthorized");
    expect(useGit.getState().previewError).toBeNull();
  });

  it("keeps preview failures out of git list errors", async () => {
    const get = vi.fn().mockRejectedValue(new AppError("timeout"));
    const api = makeApi({ get: get as never });

    await useGit.getState().loadPreviews(api, "proj");

    expect(useGit.getState().error).toBeNull();
    expect(useGit.getState().previewError).toBe("timeout");
  });

  it("allows concurrent preview responses from different scopes", async () => {
    const first = deferred<{ previews: unknown[] }>();
    const second = deferred<{ previews: unknown[] }>();
    const get = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const api = makeApi({ get: get as never });

    const firstLoad = useGit.getState().loadPreviews(api, "proj", "task_a");
    const secondLoad = useGit.getState().loadPreviews(api, "proj", "task_b");
    second.resolve({ previews: [wirePreview({ id: "prev_b", taskId: "task_b" })] });
    await secondLoad;
    first.resolve({ previews: [wirePreview({ id: "prev_a", taskId: "task_a" })] });
    await firstLoad;

    expect(useGit.getState().previews.map((preview) => preview.id)).toEqual(["prev_b", "prev_a"]);
  });

  it("ignores stale preview responses from an older request for the same scope", async () => {
    const first = deferred<{ previews: unknown[] }>();
    const second = deferred<{ previews: unknown[] }>();
    const get = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const api = makeApi({ get: get as never });

    const firstLoad = useGit.getState().loadPreviews(api, "proj", "task_a");
    const secondLoad = useGit.getState().loadPreviews(api, "proj", "task_a");
    second.resolve({ previews: [wirePreview({ id: "prev_new", taskId: "task_a" })] });
    await secondLoad;
    first.resolve({ previews: [wirePreview({ id: "prev_old", taskId: "task_a" })] });
    await firstLoad;

    expect(useGit.getState().previews.map((preview) => preview.id)).toEqual(["prev_new"]);
  });

  it("does not discard a concurrent project-wide preview response after a task-scoped load starts", async () => {
    const projectWide = deferred<{ previews: unknown[] }>();
    const taskScoped = deferred<{ previews: unknown[] }>();
    const get = vi
      .fn()
      .mockReturnValueOnce(projectWide.promise)
      .mockReturnValueOnce(taskScoped.promise);
    const api = makeApi({ get: get as never });

    const projectLoad = useGit.getState().loadPreviews(api, "proj");
    const taskLoad = useGit.getState().loadPreviews(api, "proj", "task_a");
    taskScoped.resolve({ previews: [wirePreview({ id: "prev_task", taskId: "task_a" })] });
    await taskLoad;
    projectWide.resolve({
      previews: [
        wirePreview({ id: "prev_project_a", taskId: "task_a" }),
        wirePreview({ id: "prev_project_b", taskId: "task_b" }),
      ],
    });
    await projectLoad;

    expect(useGit.getState().previews.map((preview) => preview.id)).toEqual([
      "prev_project_a",
      "prev_project_b",
    ]);
  });
});

describe("createWorktree", () => {
  it("posts a branch payload and appends the created worktree", async () => {
    const post = vi.fn().mockResolvedValue({ worktree: wireWorktree() });
    const api = makeApi({ post: post as never });

    const created = await useGit.getState().createWorktree(api, "proj", { branch: "fix/things" });

    expect(post).toHaveBeenCalledWith("/api/projects/proj/worktrees", { branch: "fix/things" });
    expect(created?.id).toBe("wt_abc123def456");
    expect(useGit.getState().worktrees.map((w: Worktree) => w.id)).toEqual(["wt_abc123def456"]);
    expect(useGit.getState().error).toBeNull();
  });

  it("drops a worktree created for a previous runtime", async () => {
    let resolvePost: (value: unknown) => void = () => undefined;
    const post = vi.fn(() => new Promise((resolve) => { resolvePost = resolve; }));
    const api = makeApi({ post: post as never });

    const pending = useGit.getState().createWorktree(api, "proj", { branch: "fix/things" });
    advanceRuntimeGeneration();
    useGit.setState({ worktrees: [] });
    resolvePost({ worktree: wireWorktree() });
    const created = await pending;

    expect(created).toBeNull();
    expect(useGit.getState().worktrees).toEqual([]);
  });

  it("posts a pr payload", async () => {
    const post = vi.fn().mockResolvedValue({
      worktree: wireWorktree({ pr: { number: 12, title: "PR 12", headRef: "h", baseRef: "main" } }),
    });
    const api = makeApi({ post: post as never });

    const created = await useGit.getState().createWorktree(api, "proj", { pr: 12 });

    expect(post).toHaveBeenCalledWith("/api/projects/proj/worktrees", { pr: 12 });
    expect(created?.pr?.number).toBe(12);
  });

  it("returns null and maps the error category on failure", async () => {
    const post = vi.fn().mockRejectedValue(new AppError("unauthorized"));
    const api = makeApi({ post: post as never });

    const created = await useGit.getState().createWorktree(api, "proj", { branch: "x" });

    expect(created).toBeNull();
    expect(useGit.getState().error).toBe("unauthorized");
    expect(useGit.getState().worktrees).toEqual([]);
  });

  it("returns null with a server error when the response shape is malformed", async () => {
    const post = vi.fn().mockResolvedValue({ worktree: { path: "no id" } });
    const api = makeApi({ post: post as never });

    const created = await useGit.getState().createWorktree(api, "proj", { branch: "x" });

    expect(created).toBeNull();
    expect(useGit.getState().error).toBe("server");
    expect(console.warn).toHaveBeenCalled();
  });

  it("replaces an existing worktree with the same id instead of duplicating", async () => {
    useGit.setState({
      worktrees: [
        {
          id: "wt_abc123def456",
          dirtyState: "unknown",
        } as Worktree,
      ],
    });
    const post = vi.fn().mockResolvedValue({ worktree: wireWorktree() });
    const api = makeApi({ post: post as never });

    await useGit.getState().createWorktree(api, "proj", { branch: "fix/things" });

    expect(useGit.getState().worktrees).toHaveLength(1);
    expect(useGit.getState().worktrees[0]?.dirtyState).toBe("clean");
  });
});
