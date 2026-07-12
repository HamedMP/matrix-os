import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@desktop/shared/app-error";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import {
  BOARD_COLUMNS,
  groupCardsByColumn,
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

describe("groupCardsByColumn", () => {
  it("groups by status, excludes archived, sorts by order then id", () => {
    const cards: Card[] = [
      card({ id: "task_b", status: "todo", order: 2 }),
      card({ id: "task_c", status: "todo", order: 1 }),
      card({ id: "task_a", status: "todo", order: 1 }),
      card({ id: "task_d", status: "running", order: 0 }),
      card({ id: "task_e", status: "archived", order: 0 }),
    ];
    const grouped = groupCardsByColumn(cards);
    expect(grouped.todo.map((c) => c.id)).toEqual(["task_a", "task_c", "task_b"]);
    expect(grouped.running.map((c) => c.id)).toEqual(["task_d"]);
    expect(grouped.archived).toEqual([]);
    expect(grouped.waiting).toEqual([]);
    expect(grouped.blocked).toEqual([]);
    expect(grouped.complete).toEqual([]);
  });

  it("defines the five visible board columns in order", () => {
    expect(BOARD_COLUMNS).toEqual(["todo", "running", "waiting", "blocked", "complete"]);
  });
});

describe("createProject", () => {
  it("keeps the gateway-owned folder and optional GitHub capability", async () => {
    const api = makeApi({
      get: vi.fn().mockResolvedValue({
        projects: [
          { slug: "folder", name: "Folder", localPath: "/home/matrix/home/workspaces/folder" },
          { slug: "repo", name: "Repo", localPath: "/home/matrix/home/projects/repo/repo", github: { owner: "o", repo: "r" } },
        ],
      }),
    });

    await useBoard.getState().loadProjects(api);

    expect(useBoard.getState().projects).toEqual([
      { slug: "folder", name: "Folder", localPath: "/home/matrix/home/workspaces/folder", githubBacked: false },
      { slug: "repo", name: "Repo", localPath: "/home/matrix/home/projects/repo/repo", githubBacked: true },
    ]);
  });

  it("POSTs a scratch project and refreshes the list", async () => {
    const post = vi.fn().mockResolvedValue({ project: { slug: "my-app", name: "My App" } });
    const get = vi.fn().mockResolvedValue({ projects: [{ slug: "my-app", name: "My App" }] });
    const api = makeApi({ post, get });

    const project = await useBoard.getState().createProject(api, { name: "My App", mode: "scratch" });
    expect(post).toHaveBeenCalledWith("/api/projects", { name: "My App", mode: "scratch" });
    expect(project).toEqual({ slug: "my-app", name: "My App" });
    expect(useBoard.getState().projects).toEqual([{ slug: "my-app", name: "My App" }]);
  });

  it("sends the url for a github project", async () => {
    const post = vi.fn().mockResolvedValue({ project: { slug: "repo", name: "repo" } });
    const api = makeApi({ post, get: vi.fn().mockResolvedValue({ projects: [] }) });
    await useBoard.getState().createProject(api, { name: "repo", mode: "github", url: "https://github.com/o/repo" });
    expect(post).toHaveBeenCalledWith("/api/projects", { name: "repo", mode: "github", url: "https://github.com/o/repo" });
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
    });
  });

  it("preserves the refresh error when creation succeeds but the project list reload fails", async () => {
    const api = makeApi({
      post: vi.fn().mockResolvedValue({ project: { slug: "my-app", name: "My App" } }),
      get: vi.fn().mockRejectedValue(new AppError("offline")),
    });

    const project = await useBoard.getState().createProject(api, { name: "My App", mode: "scratch" });

    expect(project).toEqual({ slug: "my-app", name: "My App" });
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
    expect(useBoard.getState().projects).toEqual([{ slug: "my-app", name: "My App" }]);
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
      slug: "proj",
      name: "Proj",
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

describe("refreshTasks", () => {
  it("follows nextCursor pagination", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ tasks: [wireTask({ id: "task_a" })], nextCursor: "task_a" })
      .mockResolvedValueOnce({ tasks: [wireTask({ id: "task_b" })], nextCursor: null });
    const api = makeApi({ get });
    await useBoard.getState().refreshTasks(api, "proj");
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
    await useBoard.getState().refreshTasks(bad, "proj");
    expect(useBoard.getState().cardsByProject["proj"]).toEqual([card()]);
    expect(useBoard.getState().error).toBe("server");
  });
});

describe("createTask", () => {
  it("posts the input and appends the returned card", async () => {
    const api = makeApi({
      post: vi.fn().mockResolvedValue({ task: wireTask({ id: "task_new", title: "New" }) }),
    });
    const result = await useBoard.getState().createTask(api, "proj", { title: "New" });
    expect(api.post).toHaveBeenCalledWith("/api/projects/proj/tasks", { title: "New" });
    expect(result).toEqual(card({ id: "task_new", title: "New" }));
    expect(useBoard.getState().cardsByProject["proj"]).toEqual([
      card({ id: "task_new", title: "New" }),
    ]);
  });

  it("dedupes when a task:created event arrives before the POST response", async () => {
    const response = deferred<unknown>();
    const api = makeApi({
      post: vi.fn().mockReturnValue(response.promise),
    });

    const pending = useBoard.getState().createTask(api, "proj", { title: "New" });
    useBoard.getState().applyTaskEvent({
      type: "task:created",
      task: wireTask({ id: "task_new", title: "New" }),
    });
    response.resolve({ task: wireTask({ id: "task_new", title: "New" }) });
    const result = await pending;

    expect(result).toEqual(card({ id: "task_new", title: "New" }));
    expect(useBoard.getState().cardsByProject["proj"]).toEqual([
      card({ id: "task_new", title: "New" }),
    ]);
  });

  it("returns null and records the error category on failure", async () => {
    const api = makeApi({ post: vi.fn().mockRejectedValue(new AppError("unauthorized")) });
    const result = await useBoard.getState().createTask(api, "proj", { title: "New" });
    expect(result).toBeNull();
    expect(useBoard.getState().error).toBe("unauthorized");
  });
});

describe("updateTask", () => {
  async function seed(): Promise<void> {
    const api = makeApi({
      get: vi.fn().mockResolvedValue({ tasks: [wireTask()], nextCursor: null }),
    });
    await useBoard.getState().selectProject(api, "proj");
  }

  it("applies optimistically then reconciles with the server response", async () => {
    await seed();
    const d = deferred<unknown>();
    const api = makeApi({ patch: vi.fn().mockReturnValue(d.promise) });
    const pending = useBoard.getState().updateTask(api, "proj", "task_a", { title: "Edited" });

    expect(useBoard.getState().cardsByProject["proj"]![0]!.title).toBe("Edited");

    d.resolve({ task: wireTask({ title: "Edited", updatedAt: "2026-06-13T01:00:00.000Z" }) });
    await pending;
    expect(api.patch).toHaveBeenCalledWith("/api/projects/proj/tasks/task_a", {
      title: "Edited",
    });
    expect(useBoard.getState().cardsByProject["proj"]![0]).toEqual(
      card({ title: "Edited", updatedAt: "2026-06-13T01:00:00.000Z" }),
    );
  });

  it("rolls back and refetches on failure instead of silently overwriting", async () => {
    await seed();
    const get = vi.fn().mockResolvedValue({ tasks: [wireTask()], nextCursor: null });
    const api = makeApi({
      patch: vi.fn().mockRejectedValue(new AppError("server")),
      get,
    });
    await useBoard.getState().updateTask(api, "proj", "task_a", { title: "Edited" });

    expect(useBoard.getState().cardsByProject["proj"]![0]!.title).toBe("Task A");
    expect(useBoard.getState().error).toBe("server");
    expect(get).toHaveBeenCalled();
  });

  it("serializes two rapid mutations to the same task", async () => {
    await seed();
    const d1 = deferred<unknown>();
    const order: string[] = [];
    const patch = vi
      .fn()
      .mockImplementationOnce(() => {
        order.push("first-sent");
        return d1.promise;
      })
      .mockImplementationOnce(() => {
        order.push("second-sent");
        return Promise.resolve({ task: wireTask({ title: "Second" }) });
      });
    const api = makeApi({ patch });

    const p1 = useBoard.getState().updateTask(api, "proj", "task_a", { title: "First" });
    const p2 = useBoard.getState().updateTask(api, "proj", "task_a", { title: "Second" });

    await vi.waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    order.push("first-resolved");
    d1.resolve({ task: wireTask({ title: "First" }) });
    await Promise.all([p1, p2]);

    expect(patch).toHaveBeenCalledTimes(2);
    expect(order).toEqual(["first-sent", "first-resolved", "second-sent"]);
    expect(useBoard.getState().cardsByProject["proj"]![0]!.title).toBe("Second");
  });
});

describe("moveTask and archiveTask", () => {
  async function seed(): Promise<void> {
    const api = makeApi({
      get: vi.fn().mockResolvedValue({ tasks: [wireTask()], nextCursor: null }),
    });
    await useBoard.getState().selectProject(api, "proj");
  }

  it("moveTask patches status and order optimistically", async () => {
    await seed();
    const api = makeApi({
      patch: vi
        .fn()
        .mockResolvedValue({ task: wireTask({ status: "running", order: 3 }) }),
    });
    await useBoard.getState().moveTask(api, "proj", "task_a", "running", 3);
    expect(api.patch).toHaveBeenCalledWith("/api/projects/proj/tasks/task_a", {
      status: "running",
      order: 3,
    });
    expect(useBoard.getState().cardsByProject["proj"]![0]).toMatchObject({
      status: "running",
      order: 3,
    });
  });

  it("archiveTask keeps the card visible until the server confirms archive", async () => {
    await seed();
    const d = deferred<unknown>();
    const api = makeApi({
      patch: vi.fn().mockReturnValue(d.promise),
    });
    const pending = useBoard.getState().archiveTask(api, "proj", "task_a");

    expect(groupCardsByColumn(useBoard.getState().cardsByProject["proj"]!).todo).toEqual([
      card(),
    ]);

    d.resolve({ task: wireTask({ status: "archived" }) });
    await pending;
    expect(api.patch).toHaveBeenCalledWith("/api/projects/proj/tasks/task_a", {
      status: "archived",
    });
    const grouped = groupCardsByColumn(useBoard.getState().cardsByProject["proj"]!);
    expect(grouped.todo).toEqual([]);
  });

  it("archiveTask keeps the card visible and records the error when the server rejects", async () => {
    await seed();
    const api = makeApi({ patch: vi.fn().mockRejectedValue(new AppError("server")) });
    await useBoard.getState().archiveTask(api, "proj", "task_a");
    expect(groupCardsByColumn(useBoard.getState().cardsByProject["proj"]!).todo).toEqual([
      card(),
    ]);
    expect(useBoard.getState().error).toBe("server");
  });
});

describe("deleteTask", () => {
  async function seed(): Promise<void> {
    const api = makeApi({
      get: vi.fn().mockResolvedValue({ tasks: [wireTask()], nextCursor: null }),
    });
    await useBoard.getState().selectProject(api, "proj");
  }

  it("keeps the card visible until the server confirms deletion", async () => {
    await seed();
    const d = deferred<unknown>();
    const api = makeApi({ delete: vi.fn().mockReturnValue(d.promise) });
    const pending = useBoard.getState().deleteTask(api, "proj", "task_a");

    expect(useBoard.getState().cardsByProject["proj"]).toEqual([card()]);
    d.resolve({ ok: true });
    await pending;

    expect(api.delete).toHaveBeenCalledWith("/api/projects/proj/tasks/task_a");
    expect(useBoard.getState().cardsByProject["proj"]).toEqual([]);
  });

  it("keeps the card visible and records the error when the server rejects", async () => {
    await seed();
    const api = makeApi({ delete: vi.fn().mockRejectedValue(new AppError("server")) });
    await useBoard.getState().deleteTask(api, "proj", "task_a");
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
