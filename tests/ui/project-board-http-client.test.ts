import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GENERIC_BOARD_ERROR, ProjectBoardRequestError, TaskAgentWorkingError, TaskConflictError,
} from "../../packages/ui/src/project-board/client";
import { createHttpProjectBoardClient } from "../../packages/ui/src/project-board/http-client";
import type { ProjectTask } from "../../packages/ui/src/project-board/types";

const GATEWAY = "https://app.example.test/vm/ana";

function task(number: number, overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: `task_${number}`, projectId: "proj_1", number, key: `MOS-${number}`, title: `Task ${number}`, description: "",
    status: "todo", priority: "none", rank: "V", assignee: null, labels: [], parentTaskId: null, blockedBy: [], dueAt: null,
    worktreeId: null, branch: null, pullRequest: null, externalLink: null, sessions: [], commentCount: 0,
    createdBy: "user:owner", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    archivedAt: null, revision: 1, ...overrides,
  };
}

interface Call { url: URL; method: string; body: unknown; init: RequestInit }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fake gateway: each handler answers one request in order. */
function fakeFetch(...handlers: Array<(call: Call) => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call: Call = {
      url: new URL(String(input)), method: init.method ?? "GET", init,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const handler = handlers[calls.length - 1];
    if (!handler) throw new Error(`unexpected request ${call.method} ${call.url.pathname}`);
    return handler(call);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function client(fetch: typeof globalThis.fetch) {
  return createHttpProjectBoardClient({ gatewayUrl: `${GATEWAY}/`, projectSlug: "my-proj", fetch });
}

describe("createHttpProjectBoardClient requests", () => {
  it("lists tasks by following nextCursor, same-origin with a timeout signal", async () => {
    const { fetch, calls } = fakeFetch(
      () => json({ tasks: [task(1)], nextCursor: "page_2" }),
      () => json({ tasks: [task(2)], nextCursor: null }),
    );
    const tasks = await client(fetch).listTasks();
    expect(tasks.map((entry) => entry.key)).toEqual(["MOS-1", "MOS-2"]);
    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe(`${GATEWAY}/api/projects/my-proj/tasks`);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ limit: "500", includeArchived: "false" });
    expect(calls[1]!.url.searchParams.get("cursor")).toBe("page_2");
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect(calls[0]!.init.redirect).toBe("error");
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("stops paging at the 5,000-task cap", async () => {
    const page = Array.from({ length: 500 }, (_, index) => task(index + 1));
    const { fetch, calls } = fakeFetch(...Array.from({ length: 11 }, (_, index) => () => json({ tasks: page, nextCursor: `page_${index + 2}` })));
    const tasks = await client(fetch).listTasks();
    expect(calls).toHaveLength(10);
    expect(tasks).toHaveLength(5_000);
    expect(calls[0]!.url.searchParams.get("includeArchived")).toBe("false");
  });

  it("lists active tasks separately so archived history cannot push newer active tasks past the cap", async () => {
    const archivedAt = "2026-11-02T00:00:00.000Z";
    const archivedPage = Array.from({ length: 500 }, (_, index) => task(index + 1, { archivedAt }));
    const activePage = Array.from({ length: 500 }, (_, index) => task(10_001 + index));
    const { fetch, calls } = fakeFetch(
      // Active tasks only: all 5,000 come back even though 5,000 archived tasks are older.
      ...Array.from({ length: 10 }, (_, index) => () => json({ tasks: activePage.map((entry) => ({ ...entry, id: `task_${10_001 + index * 500 + entry.number - 10_001}`, number: 10_001 + index * 500 + entry.number - 10_001 })), nextCursor: index < 9 ? `active_${index + 2}` : null })),
      // The archive walk is bounded and only contributes archived tasks.
      ...Array.from({ length: 10 }, (_, index) => () => json({ tasks: archivedPage.map((entry) => ({ ...entry, id: `task_${index * 500 + entry.number}`, number: index * 500 + entry.number })), nextCursor: `archive_${index + 2}` })),
    );
    const tasks = await client(fetch).listTasks({ includeArchived: true });
    const active = tasks.filter((entry) => entry.archivedAt === null);
    const archived = tasks.filter((entry) => entry.archivedAt !== null);
    expect(active).toHaveLength(5_000);
    expect(active.at(-1)!.number).toBe(15_000);
    expect(archived.length).toBeGreaterThan(0);
    expect(archived.length).toBeLessThanOrEqual(1_000);
    expect(calls.slice(0, 10).every((call) => call.url.searchParams.get("includeArchived") === "false")).toBe(true);
    expect(calls.slice(10).every((call) => call.url.searchParams.get("includeArchived") === "true")).toBe(true);
    expect(calls).toHaveLength(12);
  });

  it("dedupes tasks seen in both the active and archive listings by id", async () => {
    const { fetch } = fakeFetch(
      () => json({ tasks: [task(1), task(3)], nextCursor: null }),
      () => json({ tasks: [task(1), task(2, { archivedAt: "2026-11-02T00:00:00.000Z" }), task(3)], nextCursor: null }),
    );
    const tasks = await client(fetch).listTasks({ includeArchived: true });
    expect(tasks.map((entry) => entry.id)).toEqual(["task_1", "task_2", "task_3"]);
  });

  it("rejects a response that does not match the contract with a generic error", async () => {
    const { key: _key, ...withoutKey } = task(1);
    const { fetch } = fakeFetch(() => json({ tasks: [withoutKey], nextCursor: null }));
    const failure = await client(fetch).listTasks().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProjectBoardRequestError);
    expect((failure as Error).message).toBe(GENERIC_BOARD_ERROR);
  });

  it("creates a task with a JSON body and reads the 201 response", async () => {
    const { fetch, calls } = fakeFetch(() => json({ task: task(7, { title: "Ship it" }) }, 201));
    const created = await client(fetch).createTask({ title: "Ship it", status: "todo", clientRequestId: "req_abc" });
    expect(created.key).toBe("MOS-7");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url.pathname).toBe("/vm/ana/api/projects/my-proj/tasks");
    expect(calls[0]!.body).toEqual({ title: "Ship it", status: "todo", clientRequestId: "req_abc" });
    expect(new Headers(calls[0]!.init.headers).get("content-type")).toBe("application/json");
  });

  it("sends the base revision on update and maps a 409 revision conflict to TaskConflictError", async () => {
    const theirs = task(3, { title: "Their title", revision: 5 });
    const { fetch, calls } = fakeFetch(() => json({ error: { code: "task_revision_conflict", message: "Task changed" }, task: theirs }, 409));
    const failure = await client(fetch).updateTask("task_3", 4, { title: "Mine" }).catch((error: unknown) => error);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url.pathname).toBe("/vm/ana/api/projects/my-proj/tasks/task_3");
    expect(calls[0]!.body).toEqual({ baseRevision: 4, title: "Mine" });
    expect(failure).toBeInstanceOf(TaskConflictError);
    expect((failure as TaskConflictError).current).toEqual(theirs);
  });

  it("maps a 409 task_agent_working on move and passes force when confirmed", async () => {
    const { fetch, calls } = fakeFetch(
      () => json({ error: { code: "task_agent_working", message: "An agent is working" } }, 409),
      () => json({ task: task(3, { status: "done", revision: 2 }) }),
    );
    const board = client(fetch);
    await expect(board.moveTask("task_3", { status: "done" })).rejects.toBeInstanceOf(TaskAgentWorkingError);
    const moved = await board.moveTask("task_3", { status: "done", afterTaskId: "task_2", force: true });
    expect(moved.status).toBe("done");
    expect(calls[1]!.url.pathname).toBe("/vm/ana/api/projects/my-proj/tasks/task_3/move");
    expect(calls[1]!.body).toEqual({ status: "done", afterTaskId: "task_2", force: true });
  });

  it("never shows server text: known codes get local copy, everything else the generic message", async () => {
    const { fetch } = fakeFetch(
      () => json({ error: { code: "task_not_found", message: "row 42 missing in /home/matrix/home" } }, 404),
      () => json({ error: { code: "board_unavailable", message: "pg: connection refused" } }, 503),
      () => new Response("<html>bad gateway</html>", { status: 502 }),
      () => { throw new TypeError("Failed to fetch"); },
    );
    const board = client(fetch);
    const messages: string[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const failure = await board.getTask("task_1").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProjectBoardRequestError);
      messages.push((failure as Error).message);
    }
    expect(messages[0]).toBe("That task no longer exists.");
    expect(messages.slice(1)).toEqual([GENERIC_BOARD_ERROR, GENERIC_BOARD_ERROR, GENERIC_BOARD_ERROR]);
    expect(messages.join(" ")).not.toMatch(/pg:|home\/matrix|bad gateway/);
  });

  it("archives, restores and deletes with empty JSON bodies", async () => {
    const { fetch, calls } = fakeFetch(
      () => json({ task: task(1, { archivedAt: "2026-11-02T00:00:00.000Z" }) }),
      () => json({ task: task(1) }),
      () => json({ ok: true }),
    );
    const board = client(fetch);
    await board.archiveTask("task_1", true);
    await board.archiveTask("task_1", false);
    await board.deleteTask("task_1");
    expect(calls.map((call) => `${call.method} ${call.url.pathname.replace("/vm/ana/api/projects/my-proj", "")}`)).toEqual([
      "POST /tasks/task_1/archive", "POST /tasks/task_1/unarchive", "DELETE /tasks/task_1",
    ]);
    expect(calls.map((call) => call.body)).toEqual([{}, {}, {}]);
  });

  it("starts and attaches sessions and returns the task's session", async () => {
    const session = { ref: "chat_abc", kind: "chat", title: "Chat 1", role: "main", agentStatus: "working", harness: "claude" } as const;
    const { fetch, calls } = fakeFetch(
      () => json({ task: task(1, { sessions: [session] }), session }),
      () => json({ task: task(1, { sessions: [session, { ...session, ref: "term.ws_1.tab_1", kind: "terminal", title: "Tab", role: "extra" }] }) }),
      () => json({ task: task(1) }),
    );
    const board = client(fetch);
    expect(await board.startSession("task_1", { kind: "chat" })).toEqual(session);
    expect(calls[0]!.body).toEqual({ kind: "chat" });
    const attached = await board.attachSession("task_1", { ref: "term.ws_1.tab_1", kind: "terminal", title: "Tab" });
    expect(attached.ref).toBe("term.ws_1.tab_1");
    expect(calls[1]!.url.pathname).toBe("/vm/ana/api/projects/my-proj/tasks/task_1/sessions");
    expect(calls[1]!.body).toEqual({ ref: "term.ws_1.tab_1" });
    await board.detachSession("task_1", "term.ws_1.tab_1");
    expect(calls[2]!.method).toBe("DELETE");
    expect(calls[2]!.url.pathname).toBe("/vm/ana/api/projects/my-proj/tasks/task_1/sessions/term.ws_1.tab_1");
  });

  it("reads the board routes and comments", async () => {
    const { fetch, calls } = fakeFetch(
      () => json({ settings: { projectId: "proj_1", taskKey: "MOS", linearConnected: false, automation: { startMovesToInProgress: true, prOpenMovesToReview: true, prMergeMovesToDone: true } } }),
      () => json({ members: [{ actor: "user:owner", name: "Owner", handle: "owner" }] }),
      () => json({ sessions: [{ ref: "chat_loose", kind: "chat", title: "Loose chat" }] }),
      () => json({ comments: [{ id: "tcm_1", taskId: "task_1", author: "user:owner", body: "Hi", createdAt: "2026-11-01T00:00:00.000Z", editedAt: null }], nextCursor: null }),
      () => json({ activity: [{ seq: 1, taskId: "task_1", actor: "user:owner", kind: "created", summary: "Created the task", at: "2026-11-01T00:00:00.000Z" }], nextCursor: null }),
      () => json({ git: { branch: null, dirty: false, ahead: 0, behind: 0, changedFiles: 0, pullRequest: null, prStatus: "unavailable" } }),
    );
    const board = client(fetch);
    expect((await board.getSettings()).taskKey).toBe("MOS");
    expect(await board.listMembers()).toHaveLength(1);
    expect(await board.listAttachableSessions()).toHaveLength(1);
    expect(await board.listComments("task_1")).toHaveLength(1);
    expect(await board.listActivity("task_1")).toHaveLength(1);
    expect((await board.getGitSummary("task_1")).prStatus).toBe("unavailable");
    expect(calls.map((call) => call.url.pathname.replace("/vm/ana/api/projects/my-proj", ""))).toEqual([
      "/board/settings", "/board/members", "/board/attachable-sessions", "/tasks/task_1/comments", "/tasks/task_1/activity", "/tasks/task_1/git",
    ]);
  });

  it("refuses ids that are not task ids before calling the gateway", async () => {
    const { fetch, calls } = fakeFetch();
    await expect(client(fetch).getTask("../../secrets")).rejects.toBeInstanceOf(ProjectBoardRequestError);
    expect(calls).toHaveLength(0);
    expect(() => createHttpProjectBoardClient({ gatewayUrl: GATEWAY, projectSlug: "../etc", fetch })).toThrow();
  });
});

function events(list: Array<{ id: string; type: string; taskId?: string; revision?: number }>, nextCursor: string | null = null) {
  return json({
    events: list.map((event) => ({
      id: event.id, type: event.type, scope: { projectSlug: "my-proj", ...(event.taskId ? { taskId: event.taskId } : {}) },
      payload: event.revision === undefined ? {} : { revision: event.revision }, createdAt: "2026-11-01T00:00:00.000Z",
    })),
    nextCursor,
  });
}

describe("createHttpProjectBoardClient subscribe", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("skips the backlog, then polls every 2s from the last event and signals task changes", async () => {
    const { fetch, calls } = fakeFetch(
      () => events([{ id: "evt_old", type: "task.updated", taskId: "task_1", revision: 3 }]),
      () => events([
        { id: "evt_2", type: "task.moved", taskId: "task_1", revision: 4 },
        { id: "evt_3", type: "review.updated" },
        { id: "evt_4", type: "task.comment_added", taskId: "task_2", revision: 2 },
      ]),
      () => events([]),
    );
    const listener = vi.fn();
    const stop = client(fetch).subscribe(listener);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls[0]!.url.pathname).toBe("/vm/ana/api/workspace/events");
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toEqual({ projectSlug: "my-proj", limit: "100" });
    // The backlog is skipped, but subscribers get one resync once the cursor is set.
    expect(listener.mock.calls.map(([event]) => event)).toEqual([{ type: "board.resync" }]);
    listener.mockClear();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls[1]!.url.searchParams.get("cursor")).toBe("evt_old");
    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      { type: "task.moved", taskId: "task_1", revision: 4 },
      { type: "task.comment_added", taskId: "task_2", revision: 2 },
    ]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls[2]!.url.searchParams.get("cursor")).toBe("evt_4");
    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(3);
  });

  it("signals a resync after the baseline so a change between the first load and the baseline is not lost", async () => {
    // The board loaded its tasks, then task_5 changed, then the baseline ran past that change.
    const { fetch } = fakeFetch(
      () => events([{ id: "evt_1", type: "task.updated", taskId: "task_5", revision: 2 }]),
      () => events([]),
    );
    const board = client(fetch);
    const listener = vi.fn();
    board.subscribe(listener);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: "board.resync" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not advance the cursor past a page when a later page in the same poll fails", async () => {
    const { fetch, calls } = fakeFetch(
      () => events([]),
      () => events([{ id: "evt_1", type: "task.moved", taskId: "task_1", revision: 2 }], "evt_1"),
      () => new Response("nope", { status: 500 }),
      () => events([{ id: "evt_1", type: "task.moved", taskId: "task_1", revision: 2 }], "evt_1"),
      () => events([{ id: "evt_2", type: "task.updated", taskId: "task_2", revision: 3 }]),
    );
    const listener = vi.fn();
    client(fetch).subscribe(listener);
    await vi.advanceTimersByTimeAsync(0);
    listener.mockClear();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(3);
    expect(listener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls[3]!.url.searchParams.get("cursor")).toBeNull();
    expect(calls[4]!.url.searchParams.get("cursor")).toBe("evt_1");
    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      { type: "task.moved", taskId: "task_1", revision: 2 },
      { type: "task.updated", taskId: "task_2", revision: 3 },
    ]);
  });

  it("keeps one poll in flight and backs off to 10s after a failure", async () => {
    let release: (response: Response) => void = () => {};
    const { fetch, calls } = fakeFetch(
      () => new Promise<Response>((resolve) => { release = resolve; }),
      () => new Response("nope", { status: 500 }),
      () => events([]),
    );
    const stop = client(fetch).subscribe(() => {});
    await vi.advanceTimersByTimeAsync(9_000);
    expect(calls).toHaveLength(1);
    release(events([]));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(3);
    stop();
  });

  it("shares one poller between listeners and stops when the last one leaves", async () => {
    const { fetch, calls } = fakeFetch(() => events([]), () => events([]));
    const board = client(fetch);
    const stopFirst = board.subscribe(() => {});
    const stopSecond = board.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    stopFirst();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(2);
    stopSecond();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(2);
  });

  it("caps listeners by dropping the oldest", async () => {
    const { fetch } = fakeFetch(() => events([]), () => events([{ id: "evt_9", type: "task.created", taskId: "task_9", revision: 1 }]));
    const board = client(fetch);
    const first = vi.fn();
    board.subscribe(first);
    const rest = Array.from({ length: 32 }, () => vi.fn());
    for (const listener of rest) board.subscribe(listener);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(first).not.toHaveBeenCalled();
    // Each remaining listener gets the baseline resync, then the task change.
    expect(rest.every((listener) => listener.mock.calls.length === 2)).toBe(true);
  });
});
