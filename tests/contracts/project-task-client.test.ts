import { describe, expect, it, vi } from "vitest";
import {
  createProjectTaskHttpClient,
  isTaskKey,
  newTaskClientRequestId,
  ProjectTaskClientError,
  projectMatchesSession,
  resolveProjectSlug,
  resolveTaskId,
  type ProjectTaskFetch,
} from "../../packages/contracts/src/project-task-client.js";
import { taskFixture } from "./fixtures/project-task.js";


function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function client(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetcher = vi.fn<ProjectTaskFetch>(async (url, init) => handler(url, init));
  return {
    fetcher,
    client: createProjectTaskHttpClient({ baseUrl: "http://127.0.0.1:4000", fetch: fetcher, headers: () => ({ Authorization: "Bearer tok" }) }),
  };
}

// Fault detected: an agent adapter that sends unvalidated bodies or trusts unvalidated
// responses lets a broken gateway or a bad model input corrupt the board.
describe("project task HTTP client", () => {
  it("lists tasks with a validated query and a bounded deadline", async () => {
    const { client: tasks, fetcher } = client(() => json({ tasks: [taskFixture()], nextCursor: null }));
    const result = await tasks.listTasks("matrix-os", { status: "todo", q: "board", limit: 20, includeArchived: "true" });
    expect(result.tasks[0]!.key).toBe("MOS-42");
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:4000/api/projects/matrix-os/tasks?status=todo&q=board&limit=20&includeArchived=true");
    expect(init).toMatchObject({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok");
  });

  it("sends create, update, move, comment and start bodies to the contract routes without an actor", async () => {
    const { client: tasks, fetcher } = client((url) => {
      if (url.endsWith("/comments")) return json({ comment: { id: "tcm_1", taskId: "task_42", author: "agent:chat_1", body: "PR is up", createdAt: "2026-11-20T10:00:00.000Z", editedAt: null } }, 201);
      if (url.endsWith("/start")) return json({ task: taskFixture(), session: { ref: "chat_1", kind: "chat", title: "MOS-42", role: "main", agentStatus: "working" } }, 201);
      return json({ task: taskFixture() }, url.endsWith("/tasks") ? 201 : 200);
    });
    await tasks.createTask("matrix-os", { title: "  New  ", clientRequestId: "req_abc" });
    await tasks.updateTask("matrix-os", "task_42", { baseRevision: 3, title: "Renamed" });
    await tasks.moveTask("matrix-os", "task_42", { status: "done", force: true });
    await tasks.createComment("matrix-os", "task_42", { body: "PR is up" });
    await tasks.startTask("matrix-os", "task_42", { kind: "terminal", worktree: "existing" });
    const calls = fetcher.mock.calls.map(([url, init]) => [url.replace("http://127.0.0.1:4000", ""), init.method, JSON.parse(String(init.body))]);
    expect(calls).toEqual([
      ["/api/projects/matrix-os/tasks", "POST", { title: "New", clientRequestId: "req_abc" }],
      ["/api/projects/matrix-os/tasks/task_42", "PATCH", { baseRevision: 3, title: "Renamed" }],
      ["/api/projects/matrix-os/tasks/task_42/move", "POST", { status: "done", force: true }],
      ["/api/projects/matrix-os/tasks/task_42/comments", "POST", { body: "PR is up" }],
      ["/api/projects/matrix-os/tasks/task_42/start", "POST", { kind: "terminal", worktree: "existing" }],
    ]);
  });

  it("refuses an actor or unknown field in a body before contacting the gateway", async () => {
    const { client: tasks, fetcher } = client(() => json({}));
    await expect(tasks.createTask("matrix-os", { title: "x", clientRequestId: "req_a", actor: "user:else" } as never))
      .rejects.toMatchObject({ code: "invalid_request" });
    await expect(tasks.getTask("matrix-os", "../etc")).rejects.toMatchObject({ code: "invalid_request" });
    await expect(tasks.getTask("Bad Slug", "task_42")).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps contract errors to their codes and keeps the server task on a revision conflict", async () => {
    const current = taskFixture({ revision: 9 });
    const { client: tasks } = client(() => json({ error: { code: "task_revision_conflict", message: "Task changed" }, task: current }, 409));
    const error = await tasks.updateTask("matrix-os", "task_42", { baseRevision: 3, title: "x" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProjectTaskClientError);
    expect(error).toMatchObject({ code: "task_revision_conflict", status: 409 });
    expect((error as ProjectTaskClientError).task?.revision).toBe(9);
  });

  it("never surfaces raw server text, and separates auth, timeout and network failures", async () => {
    const raw = await client(() => new Response("pg: connection refused at /var/lib/postgres", { status: 500 }))
      .client.getTask("matrix-os", "task_42").catch((caught: unknown) => caught as ProjectTaskClientError);
    expect(raw).toMatchObject({ code: "unavailable" });
    expect(raw.message).not.toContain("postgres");
    await expect(client(() => new Response("no", { status: 401 })).client.getTask("matrix-os", "task_42"))
      .rejects.toMatchObject({ code: "unauthorized" });
    await expect(client(() => { throw new DOMException("t", "TimeoutError"); }).client.getTask("matrix-os", "task_42"))
      .rejects.toMatchObject({ code: "timeout" });
    await expect(client(() => { throw new TypeError("fetch failed"); }).client.getTask("matrix-os", "task_42"))
      .rejects.toMatchObject({ code: "unavailable" });
    await expect(client(() => json({ task: { id: "nope" } })).client.getTask("matrix-os", "task_42"))
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  /** A body of `mebibytes` 1 MiB chunks that records how many the client pulled. */
  function stream(mebibytes: number, pulled: { count: number }): Response {
    return new Response(new ReadableStream({
      pull(controller) {
        if (pulled.count >= mebibytes) { controller.close(); return; }
        pulled.count += 1;
        controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
      },
    }, { highWaterMark: 0 }), { status: 200 });
  }

  it("refuses an oversized response instead of buffering it", async () => {
    const page = { count: 0 };
    await expect(client(() => stream(40, page)).client.listTasks("matrix-os")).rejects.toMatchObject({ code: "invalid_response" });
    expect(page.count).toBeLessThan(40);
    // A single task (or a mutation's answer) has a far smaller bound than a page of tasks.
    const single = { count: 0 };
    await expect(client(() => stream(4, single)).client.getTask("matrix-os", "task_42")).rejects.toMatchObject({ code: "invalid_response" });
    expect(single.count).toBeLessThan(4);
  });

  // Fault detected: one 16 MiB cap for every response refused valid list pages (up to 500
  // tasks, each with a 50,000-character description), so large boards could not be listed.
  it("lists in small pages, following the cursor, so a page of maximum-size tasks always fits", async () => {
    const description = "é".repeat(50_000);
    const { client: tasks, fetcher } = client((url) => {
      const search = new URL(url).searchParams;
      const offset = Number(search.get("cursor")?.slice(1) ?? "0");
      const limit = Number(search.get("limit") ?? "200");
      const count = Math.min(limit, 260 - offset);
      const page = Array.from({ length: count }, (_, index) => taskFixture({ id: `task_${offset + index}`, description }));
      return json({ tasks: page, nextCursor: offset + count < 260 ? `c${offset + count}` : null });
    });
    const listed = await tasks.listTasks("matrix-os");
    expect(listed.tasks).toHaveLength(200);
    expect(listed.nextCursor).toBe("c200");
    const limits = fetcher.mock.calls.map(([url]) => Number(new URL(url).searchParams.get("limit")));
    expect(limits).toEqual([50, 50, 50, 50]);
    expect(fetcher.mock.calls.map(([url]) => new URL(url).searchParams.get("cursor"))).toEqual([null, "c50", "c100", "c150"]);

    fetcher.mockClear();
    const rest = await tasks.listTasks("matrix-os", { cursor: "c200", limit: 500 });
    expect(rest.tasks.map((task) => task.id)).toEqual(Array.from({ length: 60 }, (_, index) => `task_${200 + index}`));
    expect(rest.nextCursor).toBeNull();
    expect(fetcher.mock.calls.map(([url]) => Number(new URL(url).searchParams.get("limit")))).toEqual([50, 50]);
  });

  it("stops following a cursor that returns empty pages", async () => {
    const { client: tasks, fetcher } = client(() => json({ tasks: [], nextCursor: "again" }));
    await expect(tasks.listTasks("matrix-os", { limit: 500 })).resolves.toEqual({ tasks: [], nextCursor: "again" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("treats a failing auth header provider as unauthorized without calling fetch", async () => {
    const fetcher = vi.fn<ProjectTaskFetch>();
    const tasks = createProjectTaskHttpClient({ baseUrl: "http://x", fetch: fetcher, headers: () => { throw new Error("no token"); } });
    await expect(tasks.getTask("matrix-os", "task_42")).rejects.toMatchObject({ code: "unauthorized" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("task and project references", () => {
  it("resolves a display key through search and an id directly", async () => {
    const { client: tasks, fetcher } = client(() => json({ tasks: [taskFixture({ id: "task_420", key: "MOS-420" }), taskFixture()], nextCursor: null }));
    await expect(resolveTaskId(tasks, "matrix-os", "task_7")).resolves.toBe("task_7");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(resolveTaskId(tasks, "matrix-os", "mos-42")).resolves.toBe("task_42");
    expect(fetcher.mock.calls[0]![0]).toContain("q=MOS-42");
    expect(fetcher.mock.calls[0]![0]).toContain("includeArchived=true");
    await expect(resolveTaskId(tasks, "matrix-os", "MOS-7")).rejects.toMatchObject({ code: "task_not_found" });
    await expect(resolveTaskId(tasks, "matrix-os", "not a task")).rejects.toMatchObject({ code: "invalid_request" });
    expect(isTaskKey("MOS-42")).toBe(true);
    expect(isTaskKey("done")).toBe(false);
  });

  // Fault detected: key lookup read only the first search page, so a task whose key was
  // pushed past it by title matches looked missing.
  it("follows search pages until the exact key is found, within the board cap", async () => {
    const pages: Record<string, { tasks: ReturnType<typeof taskFixture>[]; nextCursor: string | null }> = {
      first: { tasks: [taskFixture({ id: "task_1", key: "MOS-1", title: "MOS-42 follow-up" })], nextCursor: "page2" },
      page2: { tasks: [taskFixture({ id: "task_2", key: "MOS-2" })], nextCursor: "page3" },
      page3: { tasks: [taskFixture()], nextCursor: "page4" },
    };
    const { client: tasks, fetcher } = client((url) => json(pages[new URL(url).searchParams.get("cursor") ?? "first"]));
    await expect(resolveTaskId(tasks, "matrix-os", "MOS-42")).resolves.toBe("task_42");
    expect(fetcher.mock.calls.map(([url]) => new URL(url).searchParams.get("cursor"))).toEqual([null, "page2", "page3"]);

    const endless = client(() => json({ tasks: [taskFixture({ id: "task_9", key: "MOS-9" })], nextCursor: "again" }));
    await expect(resolveTaskId(endless.client, "matrix-os", "MOS-42")).rejects.toMatchObject({ code: "task_not_found" });
    const limit = Number(new URL(endless.fetcher.mock.calls[0]![0]).searchParams.get("limit"));
    expect(endless.fetcher.mock.calls.length).toBe(Math.ceil(5_000 / limit));
  });

  // Fault detected: comments and activity stopped at the first page with no way to ask for more.
  it("pages comments by cursor and activity by sequence", async () => {
    const { client: tasks, fetcher } = client((url) => (url.includes("/activity")
      ? json({ activity: [], nextCursor: null }) : json({ comments: [], nextCursor: null })));
    await tasks.listComments("matrix-os", "task_42", { cursor: "tcm_200", limit: 50 });
    await tasks.listActivity("matrix-os", "task_42", { cursor: "200" });
    await tasks.listComments("matrix-os", "task_42");
    expect(fetcher.mock.calls.map(([url]) => url.replace("http://127.0.0.1:4000", ""))).toEqual([
      "/api/projects/matrix-os/tasks/task_42/comments?cursor=tcm_200&limit=50",
      "/api/projects/matrix-os/tasks/task_42/activity?after=200&limit=50",
      "/api/projects/matrix-os/tasks/task_42/comments?limit=50",
    ]);
    await expect(tasks.listActivity("matrix-os", "task_42", { cursor: "tcm_1" })).rejects.toMatchObject({ code: "invalid_request" });

    // Larger requests are read in pages of 50, following the cursor.
    const comment = (id: number) => ({ id: `tcm_${id}`, taskId: "task_42", author: "user:u", body: "x".repeat(10_000), createdAt: "2026-11-20T10:00:00.000Z", editedAt: null });
    const paged = client((url) => {
      const search = new URL(url).searchParams;
      const from = Number(search.get("cursor")?.slice(4) ?? "0");
      const count = Math.min(Number(search.get("limit")), 120 - from);
      return json({ comments: Array.from({ length: count }, (_, index) => comment(from + index)), nextCursor: from + count < 120 ? `tcm_${from + count}` : null });
    });
    const all = await paged.client.listComments("matrix-os", "task_42", { limit: 500 });
    expect(all.comments).toHaveLength(120);
    expect(all.nextCursor).toBeNull();
    expect(paged.fetcher.mock.calls.map(([url]) => new URL(url).searchParams.get("limit"))).toEqual(["50", "50", "50"]);
    await expect(tasks.listComments("matrix-os", "task_42", { cursor: "../x" })).rejects.toMatchObject({ code: "invalid_request" });
  });

  // Fault detected: a session-bound credential had no way to learn its own project, so
  // terminal and chat agents could not resolve the project the gateway bounds them to.
  it("reads the session binding the gateway derives from the credential", async () => {
    const { client: tasks, fetcher } = client(() => json({ session: { projectId: "proj_alpha", projectSlug: "matrix-os", taskId: "task_42" } }));
    await expect(tasks.getSession()).resolves.toEqual({ projectId: "proj_alpha", projectSlug: "matrix-os", taskId: "task_42" });
    expect(fetcher.mock.calls[0]![0]).toBe("http://127.0.0.1:4000/api/project-tasks/session");
    await expect(client(() => json({ session: null })).client.getSession()).resolves.toBeNull();
    await expect(client(() => json({ session: { projectId: "../x", projectSlug: "matrix-os" } })).client.getSession())
      .rejects.toMatchObject({ code: "invalid_response" });
  });

  it("resolves a session project id to its slug and refuses an unknown one", async () => {
    const { client: tasks } = client(() => json({ projects: [{ id: "proj_alpha", slug: "matrix-os", name: "Matrix" }], nextCursor: null }));
    await expect(resolveProjectSlug(tasks, "proj_alpha")).resolves.toBe("matrix-os");
    await expect(resolveProjectSlug(tasks, "proj_other")).rejects.toMatchObject({ code: "project_not_found" });
  });

  it("matches a project by slug or id only for the session's own project", () => {
    const session = { projectId: "proj_alpha", projectSlug: "matrix-os" };
    expect(projectMatchesSession(session, "matrix-os")).toBe(true);
    expect(projectMatchesSession(session, "proj_alpha")).toBe(true);
    expect(projectMatchesSession(session, "other")).toBe(false);
  });

  it("creates retry keys in the contract format", () => {
    expect(newTaskClientRequestId()).toMatch(/^req_[A-Za-z0-9_-]{1,128}$/);
  });
});
