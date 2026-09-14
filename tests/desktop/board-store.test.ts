import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@desktop/shared/app-error";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import {
  useBoard,
  type Card,
} from "@desktop/renderer/src/stores/board";

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
    get: vi.fn().mockResolvedValue({ tasks: [], nextCursor: null }),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({ ok: true }),
    putText: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as ApiClient;
}

// Mirrors the gateway TaskRecord wire shape (packages/gateway/src/task-manager.ts).
function wireTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task_a",
    projectSlug: "proj",
    title: "Task A",
    status: "todo",
    priority: "normal",
    order: 0,
    previewIds: [],
    createdAt: "2026-06-13T00:00:00.000Z",
    updatedAt: "2026-06-13T00:00:00.000Z",
    ...overrides,
  };
}

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: "task_a",
    projectSlug: "proj",
    title: "Task A",
    description: "",
    status: "todo",
    priority: "normal",
    order: 0,
    parentTaskId: null,
    linkedSessionId: null,
    linkedWorktreeId: null,
    previewIds: [],
    tags: [],
    updatedAt: "2026-06-13T00:00:00.000Z",
    revision: null,
    ...overrides,
  };
}

beforeEach(() => {
  useBoard.setState(useBoard.getInitialState(), true);
});

describe("createProject", () => {
  it("keeps the gateway-owned folder and optional GitHub capability", async () => {
    const api = makeApi({
      get: vi.fn().mockResolvedValue({
        projects: [
          { slug: "folder", name: "Folder", kind: "folder", localPath: "/home/matrix/home/workspaces/folder" },
          { slug: "repo", name: "Repo", kind: "github", localPath: "/home/matrix/home/projects/repo/repo", defaultBranch: "main", github: { owner: "o", repo: "r" } },
        ],
      }),
    });

    await useBoard.getState().loadProjects(api);

    expect(useBoard.getState().projects).toEqual([
      { slug: "folder", name: "Folder", kind: "folder", localPath: "/home/matrix/home/workspaces/folder", githubBacked: false },
      {
        slug: "repo",
        name: "Repo",
        kind: "github",
        localPath: "/home/matrix/home/projects/repo/repo",
        githubBacked: true,
        github: { owner: "o", repo: "r" },
        repository: "o/r",
        defaultBranch: "main",
      },
    ]);
  });

  it("POSTs a scratch project and refreshes the list", async () => {
    const post = vi.fn().mockResolvedValue({ project: { slug: "my-app", name: "My App" } });
    const get = vi.fn().mockResolvedValue({ projects: [{ slug: "my-app", name: "My App" }] });
    const api = makeApi({ post, get });

    const project = await useBoard.getState().createProject(api, { name: "My App", mode: "scratch" });
    expect(post).toHaveBeenCalledWith("/api/projects", {
      name: "My App",
      mode: "scratch",
      clientRequestId: expect.stringMatching(/^req_[A-Za-z0-9_-]+$/),
    }, { timeoutMs: 30_000 });
    expect(project).toEqual({ slug: "my-app", name: "My App", kind: "scratch" });
    expect(useBoard.getState().projects).toEqual([{ slug: "my-app", name: "My App", kind: "scratch" }]);
  });

  it("persists the optional project goal with project creation", async () => {
    const post = vi.fn().mockResolvedValue({
      project: { slug: "portfolio", name: "Portfolio", description: "Build my portfolio" },
    });
    const get = vi.fn().mockResolvedValue({ projects: [] });
    const api = makeApi({ post, get });

    await useBoard.getState().createProject(api, {
      name: "Portfolio",
      description: "Build my portfolio",
      mode: "scratch",
    });

    expect(post).toHaveBeenCalledWith(
      "/api/projects",
      expect.objectContaining({ description: "Build my portfolio" }),
      { timeoutMs: 30_000 },
    );
  });

  it("recovers a timed-out project create with one idempotent retry", async () => {
    const createdResponse = { project: { slug: "my-app", name: "My App" } };
    const post = vi.fn()
      .mockRejectedValueOnce(new AppError("timeout"))
      .mockResolvedValueOnce(createdResponse);
    const get = vi.fn().mockResolvedValue({ projects: [createdResponse.project] });
    const api = makeApi({ post, get });

    const project = await useBoard.getState().createProject(api, { name: "My App", mode: "scratch" });

    expect(project).toEqual({ slug: "my-app", name: "My App", kind: "scratch" });
    expect(post).toHaveBeenCalledTimes(2);
    const firstBody = post.mock.calls[0]?.[1];
    const retryBody = post.mock.calls[1]?.[1];
    expect(firstBody).toMatchObject({
      name: "My App",
      mode: "scratch",
      clientRequestId: expect.stringMatching(/^req_[A-Za-z0-9_-]+$/),
    });
    expect(retryBody).toEqual(firstBody);
    expect(post.mock.calls[0]?.[2]).toEqual({ timeoutMs: 30_000 });
    expect(post.mock.calls[1]?.[2]).toEqual({ timeoutMs: 310_000 });
    expect(useBoard.getState().error).toBeNull();
  });

  it("sends the url for a github project", async () => {
    const post = vi.fn().mockResolvedValue({ project: { slug: "repo", name: "repo" } });
    const api = makeApi({ post, get: vi.fn().mockResolvedValue({ projects: [] }) });
    await useBoard.getState().createProject(api, { name: "repo", mode: "github", url: "https://github.com/o/repo" });
    expect(post).toHaveBeenCalledWith("/api/projects", {
      name: "repo",
      mode: "github",
      url: "https://github.com/o/repo",
      clientRequestId: expect.stringMatching(/^req_[A-Za-z0-9_-]+$/),
    }, { timeoutMs: 30_000 });
  });

  it("connects a project to an existing computer folder", async () => {
    const post = vi.fn().mockResolvedValue({
      project: { slug: "app", name: "App", localPath: "/home/matrix/home/workspaces/app" },
    });
    const api = makeApi({ post, get: vi.fn().mockResolvedValue({ projects: [] }) });

    await useBoard.getState().createProject(api, {
      name: "App",
      mode: "folder",
      path: "workspaces/app",
    });

    expect(post).toHaveBeenCalledWith("/api/projects", {
      name: "App",
      mode: "folder",
      path: "workspaces/app",
      clientRequestId: expect.stringMatching(/^req_[A-Za-z0-9_-]+$/),
    }, { timeoutMs: 30_000 });
  });

  it("preserves the refresh error when creation succeeds but the project list reload fails", async () => {
    const api = makeApi({
      post: vi.fn().mockResolvedValue({ project: { slug: "my-app", name: "My App" } }),
      get: vi.fn().mockRejectedValue(new AppError("offline")),
    });

    const project = await useBoard.getState().createProject(api, { name: "My App", mode: "scratch" });

    expect(project).toEqual({ slug: "my-app", name: "My App", kind: "scratch" });
    expect(useBoard.getState().error).toBe("offline");
  });

  it("refreshes projects even when a successful create response is malformed", async () => {
    const api = makeApi({
      post: vi.fn().mockResolvedValue({ project: { name: "Missing slug" } }),
      get: vi.fn().mockResolvedValue({ projects: [{ slug: "my-app", name: "My App" }] }),
    });

    const project = await useBoard.getState().createProject(api, { name: "My App", mode: "scratch" });

    expect(project).toBeNull();
    expect(api.get).toHaveBeenCalledWith("/api/workspace/projects");
    expect(useBoard.getState().projects).toEqual([{ slug: "my-app", name: "My App", kind: "scratch" }]);
    expect(useBoard.getState().error).toBe("server");
  });

  it("returns null and sets an error category on failure", async () => {
    const api = makeApi({ post: vi.fn().mockRejectedValue(new AppError("server")) });
    const project = await useBoard.getState().createProject(api, { name: "x", mode: "scratch" });
    expect(project).toBeNull();
    expect(useBoard.getState().error).toBe("server");
  });
});

describe("linkSession", () => {
  it("optimistically links a session and persists the patch", async () => {
    const patched = wireTask({ linkedSessionId: "sess_1", status: "running" });
    const patch = vi.fn().mockResolvedValue({ task: patched });
    const api = makeApi({ patch });
    useBoard.setState({ cardsByProject: { proj: [card({ id: "task_a" })] } });

    await useBoard.getState().linkSession(api, "proj", "task_a", {
      linkedSessionId: "sess_1",
      status: "running",
    });

    expect(patch).toHaveBeenCalledWith(
      "/api/projects/proj/tasks/task_a",
      { linkedSessionId: "sess_1", status: "running" },
    );
    const updated = useBoard.getState().cardsByProject["proj"]![0]!;
    expect(updated.linkedSessionId).toBe("sess_1");
    expect(updated.status).toBe("running");
    expect(useBoard.getState().error).toBeNull();
  });

  it("rolls back and surfaces an error category on failure", async () => {
    const api = makeApi({
      patch: vi.fn().mockRejectedValue(new AppError("server")),
      get: vi.fn().mockResolvedValue({ tasks: [], nextCursor: null }),
    });
    useBoard.setState({ cardsByProject: { proj: [card({ id: "task_a", linkedSessionId: null })] } });

    await expect(
      useBoard.getState().linkSession(api, "proj", "task_a", { linkedSessionId: "sess_1" }),
    ).rejects.toBeInstanceOf(AppError);
    expect(useBoard.getState().error).toBe("server");
  });

  it("rejects instead of reporting success when the task is missing locally", async () => {
    const patch = vi.fn().mockResolvedValue({ task: wireTask({ linkedSessionId: "sess_1" }) });
    const api = makeApi({ patch });

    await expect(
      useBoard.getState().linkSession(api, "proj", "task_a", { linkedSessionId: "sess_1" }),
    ).rejects.toBeInstanceOf(AppError);
    expect(patch).not.toHaveBeenCalled();
    expect(useBoard.getState().error).toBe("server");
  });
});

describe("loadProjects", () => {
  it("loads the project list from /api/workspace/projects", async () => {
    const api = makeApi({
      get: vi.fn().mockResolvedValue({
        projects: [
          { id: "p1", slug: "proj", name: "Proj", localPath: "/x", addedAt: "", updatedAt: "", ownerScope: { type: "user", id: "u" } },
        ],
        nextCursor: null,
      }),
    });
    await useBoard.getState().loadProjects(api);
    expect(api.get).toHaveBeenCalledWith("/api/workspace/projects");
    expect(useBoard.getState().projects).toEqual([{
      id: "p1",
      slug: "proj",
      name: "Proj",
      kind: "scratch",
      localPath: "/x",
      githubBacked: false,
    }]);
    expect(useBoard.getState().error).toBeNull();
  });

  it("maps failures to an error category, never raw messages", async () => {
    const api = makeApi({
      get: vi.fn().mockRejectedValue(new AppError("offline")),
    });
    await useBoard.getState().loadProjects(api);
    expect(useBoard.getState().error).toBe("offline");
    expect(useBoard.getState().projects).toEqual([]);
  });
});

describe("selectProject (stale-while-revalidate)", () => {
  it("shows skeleton only on first load of a project", async () => {
    const d = deferred<unknown>();
    const api = makeApi({ get: vi.fn().mockReturnValue(d.promise) });
    const pending = useBoard.getState().selectProject(api, "proj");

    expect(useBoard.getState().activeProjectSlug).toBe("proj");
    expect(useBoard.getState().firstLoadByProject["proj"]).toBe(true);
    expect(useBoard.getState().refreshing).toBe(true);

    d.resolve({ tasks: [wireTask()], nextCursor: null });
    await pending;

    expect(useBoard.getState().firstLoadByProject["proj"]).toBe(false);
    expect(useBoard.getState().refreshing).toBe(false);
    expect(useBoard.getState().cardsByProject["proj"]).toEqual([card()]);
  });

  it("keeps cached cards visible while refreshing an already-loaded project", async () => {
    const first = makeApi({
      get: vi.fn().mockResolvedValue({ tasks: [wireTask()], nextCursor: null }),
    });
    await useBoard.getState().selectProject(first, "proj");

    const d = deferred<unknown>();
    const second = makeApi({ get: vi.fn().mockReturnValue(d.promise) });
    const pending = useBoard.getState().selectProject(second, "proj");

    expect(useBoard.getState().firstLoadByProject["proj"]).toBe(false);
    expect(useBoard.getState().refreshing).toBe(true);
    expect(useBoard.getState().cardsByProject["proj"]).toEqual([card()]);

    d.resolve({ tasks: [wireTask({ title: "Renamed" })], nextCursor: null });
    await pending;
    expect(useBoard.getState().cardsByProject["proj"]).toEqual([card({ title: "Renamed" })]);
  });

  it("clears the skeleton and sets an error category when the first load fails", async () => {
    const api = makeApi({ get: vi.fn().mockRejectedValue(new AppError("timeout")) });
    await useBoard.getState().selectProject(api, "proj");
    expect(useBoard.getState().firstLoadByProject["proj"]).toBe(false);
    expect(useBoard.getState().refreshing).toBe(false);
    expect(useBoard.getState().error).toBe("timeout");
  });
});

describe("task catalog refresh", () => {
  it("follows nextCursor pagination", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ tasks: [wireTask({ id: "task_a" })], nextCursor: "task_a" })
      .mockResolvedValueOnce({ tasks: [wireTask({ id: "task_b" })], nextCursor: null });
    const api = makeApi({ get });
    await useBoard.getState().selectProject(api, "proj");
    expect(get).toHaveBeenCalledTimes(2);
    expect(String(get.mock.calls[1]![0])).toContain("cursor=task_a");
    expect(useBoard.getState().cardsByProject["proj"]!.map((c) => c.id)).toEqual([
      "task_a",
      "task_b",
    ]);
  });

  it("keeps cached cards and sets an error category on failure", async () => {
    const ok = makeApi({
      get: vi.fn().mockResolvedValue({ tasks: [wireTask()], nextCursor: null }),
    });
    await useBoard.getState().selectProject(ok, "proj");

    const bad = makeApi({ get: vi.fn().mockRejectedValue(new AppError("server")) });
    await useBoard.getState().selectProject(bad, "proj");
    expect(useBoard.getState().cardsByProject["proj"]).toEqual([card()]);
    expect(useBoard.getState().error).toBe("server");
  });
});

describe("applyTaskEvent", () => {
  it("adds a card on task:created and dedupes by id", () => {
    useBoard.getState().applyTaskEvent({ type: "task:created", task: wireTask() });
    useBoard.getState().applyTaskEvent({ type: "task:created", task: wireTask() });
    expect(useBoard.getState().cardsByProject["proj"]).toEqual([card()]);
  });

  it("updates status on task:updated", () => {
    useBoard.getState().applyTaskEvent({ type: "task:created", task: wireTask() });
    useBoard.getState().applyTaskEvent({ type: "task:updated", taskId: "task_a", status: "running" });
    expect(useBoard.getState().cardsByProject["proj"]![0]!.status).toBe("running");
  });

  it("ignores unknown task ids, invalid statuses, and malformed payloads", () => {
    useBoard.getState().applyTaskEvent({ type: "task:created", task: wireTask() });
    useBoard.getState().applyTaskEvent({ type: "task:updated", taskId: "task_zzz", status: "running" });
    useBoard.getState().applyTaskEvent({ type: "task:updated", taskId: "task_a", status: "exploded" });
    useBoard.getState().applyTaskEvent({ type: "task:created", task: { nonsense: true } });
    expect(useBoard.getState().cardsByProject["proj"]).toEqual([card()]);
  });
});
