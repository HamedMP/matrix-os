import { describe, expect, it, vi } from "vitest";
import { ProjectBoardRequestError, TaskConflictError } from "../../packages/ui/src/project-board/client";
import { createFixtureProjectBoardClient } from "../../packages/ui/src/project-board/fixture-client";
import { groupTasksByStatus, rollUpTaskAgentStatus } from "../../packages/ui/src/project-board/board-model";

const fast = () => createFixtureProjectBoardClient({ latencyMs: 0 });

describe("createFixtureProjectBoardClient", () => {
  it("seeds a board that exercises every card state the UI renders", async () => {
    const tasks = await fast().listTasks({ includeArchived: true });
    expect(tasks.length).toBeGreaterThanOrEqual(16);
    const groups = groupTasksByStatus(tasks);
    for (const status of ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const) {
      expect(groups[status].length, status).toBeGreaterThan(0);
    }
    const badges = new Set(tasks.map((task) => rollUpTaskAgentStatus(task.sessions)));
    for (const badge of ["working", "blocked", "done", "idle", undefined]) expect(badges.has(badge as never), String(badge)).toBe(true);
    expect(tasks.some((task) => task.pullRequest?.checks === "failing")).toBe(true);
    expect(tasks.some((task) => task.pullRequest?.checks === "passing")).toBe(true);
    expect(tasks.some((task) => task.pullRequest?.state === "merged")).toBe(true);
    expect(tasks.some((task) => task.externalLink?.provider === "linear")).toBe(true);
    expect(tasks.some((task) => task.parentTaskId !== null)).toBe(true);
    expect(tasks.some((task) => task.blockedBy.length > 0)).toBe(true);
    expect(tasks.some((task) => task.assignee === null)).toBe(true);
    expect(tasks.some((task) => task.priority === "urgent")).toBe(true);
    expect(tasks.some((task) => task.archivedAt !== null)).toBe(true);
  });

  it("starts empty when asked, for the empty state", async () => {
    expect(await createFixtureProjectBoardClient({ latencyMs: 0, empty: true }).listTasks()).toEqual([]);
  });

  it("leaves archived tasks out unless asked for them", async () => {
    const client = fast();
    expect((await client.listTasks()).some((task) => task.archivedAt !== null)).toBe(false);
  });

  it("moves a task between its new neighbours, logs the move and signals subscribers", async () => {
    const client = fast();
    const listener = vi.fn();
    client.subscribe(listener);
    const groups = groupTasksByStatus(await client.listTasks());
    const [moving] = groups.backlog;
    const [first, second] = groups.in_review;
    const moved = await client.moveTask(moving!.id, { status: "in_review", afterTaskId: first!.id, beforeTaskId: second?.id });
    expect(moved.status).toBe("in_review");
    expect(moved.rank > first!.rank).toBe(true);
    if (second) expect(moved.rank < second.rank).toBe(true);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: "task.moved", taskId: moving!.id }));
    const activity = await client.listActivity(moving!.id);
    expect(activity.at(-1)).toMatchObject({ kind: "moved", summary: "Backlog → In review" });
  });

  it("fails every mutation with a generic error while failure is simulated", async () => {
    const client = fast();
    const [task] = await client.listTasks();
    client.setSimulateFailure(true);
    await expect(client.moveTask(task!.id, { status: "done" })).rejects.toBeInstanceOf(ProjectBoardRequestError);
    await expect(client.addComment(task!.id, "hi")).rejects.toBeInstanceOf(ProjectBoardRequestError);
    expect((await client.getTask(task!.id)).status).toBe(task!.status);
    client.setSimulateFailure(false);
    await expect(client.moveTask(task!.id, { status: "done" })).resolves.toMatchObject({ status: "done" });
  });

  it("rejects a stale edit with the current task", async () => {
    const client = fast();
    const [task] = await client.listTasks();
    await client.updateTask(task!.id, task!.revision, { title: "First" });
    const stale = client.updateTask(task!.id, task!.revision, { title: "Second" });
    await expect(stale).rejects.toBeInstanceOf(TaskConflictError);
    await expect(stale).rejects.toMatchObject({ current: { title: "First" } });
  });

  it("creates tasks with the next number, once per client request id", async () => {
    const client = fast();
    const before = await client.listTasks({ includeArchived: true });
    const highest = Math.max(...before.map((task) => task.number));
    const created = await client.createTask({ title: "New thing", status: "todo", clientRequestId: "req-1" });
    const retried = await client.createTask({ title: "New thing", status: "todo", clientRequestId: "req-1" });
    expect(created.number).toBe(highest + 1);
    expect(retried.id).toBe(created.id);
    expect((await client.listTasks({ includeArchived: true })).length).toBe(before.length + 1);
  });

  it("counts comments and starts sessions that move the card forward", async () => {
    const client = createFixtureProjectBoardClient({ latencyMs: 0, empty: true });
    const created = await client.createTask({ title: "Do it", status: "todo", clientRequestId: "req-2" });
    await client.addComment(created.id, "On it @ana");
    const session = await client.startSession(created.id, { kind: "chat" });
    const task = await client.getTask(created.id);
    expect(task.commentCount).toBe(1);
    expect(task.status).toBe("in_progress");
    expect(task.sessions).toEqual([session]);
    expect(session.role).toBe("main");
    expect(task.branch).toMatch(/^task\/mos-\d+-do-it$/);
  });
});
