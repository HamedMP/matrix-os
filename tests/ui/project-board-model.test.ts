import { describe, expect, it } from "vitest";
import {
  EMPTY_BOARD_FILTER, applyPendingMoves, boardFilterIsActive, groupTasksByStatus, keyboardMoveTarget, matchesBoardFilter,
  planMove, rollUpTaskAgentStatus, sortTasksForList,
} from "../../packages/ui/src/project-board/board-model";
import type { ProjectTask, TaskSession } from "../../packages/ui/src/project-board/types";

function task(id: string, overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id, projectId: "proj_1", number: Number(id.replace(/\D/g, "")) || 1, key: `MOS-${Number(id.replace(/\D/g, "")) || 1}`, title: `Task ${id}`, description: "",
    status: "todo", priority: "none", rank: "a", assignee: null, labels: [], parentTaskId: null, blockedBy: [],
    dueAt: null, worktreeId: null, branch: null, pullRequest: null, externalLink: null, sessions: [], commentCount: 0,
    createdBy: "user:owner", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    archivedAt: null, revision: 1, ...overrides,
  };
}

function session(agentStatus: TaskSession["agentStatus"]): TaskSession {
  return { ref: `chat_${agentStatus}`, kind: "chat", title: "Chat", role: "main", agentStatus };
}

describe("groupTasksByStatus", () => {
  it("puts each task in its status column in rank order", () => {
    const groups = groupTasksByStatus([
      task("t1", { status: "todo", rank: "c" }), task("t2", { status: "todo", rank: "a" }),
      task("t3", { status: "done", rank: "b" }), task("t4", { status: "canceled" }),
    ]);
    expect(groups.todo.map((t) => t.id)).toEqual(["t2", "t1"]);
    expect(groups.done.map((t) => t.id)).toEqual(["t3"]);
    expect(groups.backlog).toEqual([]);
    expect(groups.canceled.map((t) => t.id)).toEqual(["t4"]);
  });
});

describe("planMove", () => {
  const column = [task("t1", { rank: "b" }), task("t2", { rank: "d" }), task("t3", { rank: "f" })];

  it("drops a card between two others with their ids as neighbours", () => {
    const plan = planMove(column, "t9", 1);
    expect(plan.afterTaskId).toBe("t1");
    expect(plan.beforeTaskId).toBe("t2");
    expect(plan.rank > "b" && plan.rank < "d").toBe(true);
  });

  it("moves a card within its own column without counting itself", () => {
    // t1 dragged below t2: without t1 the column is [t2, t3], target index 1.
    const plan = planMove(column, "t1", 1);
    expect(plan.afterTaskId).toBe("t2");
    expect(plan.beforeTaskId).toBe("t3");
  });

  it("goes to the top or the bottom at the ends", () => {
    expect(planMove(column, "t9", 0)).toMatchObject({ afterTaskId: undefined, beforeTaskId: "t1" });
    expect(planMove(column, "t9", 99)).toMatchObject({ afterTaskId: "t3", beforeTaskId: undefined });
    expect(planMove([], "t9", 0)).toMatchObject({ afterTaskId: undefined, beforeTaskId: undefined });
  });
});

describe("applyPendingMoves", () => {
  it("shows an optimistic move until the server confirms or it is dropped", () => {
    const tasks = [task("t1", { status: "todo", rank: "b" })];
    const moved = applyPendingMoves(tasks, { t1: { status: "in_progress", rank: "c" } });
    expect(moved[0]).toMatchObject({ status: "in_progress", rank: "c" });
    expect(tasks[0]!.status).toBe("todo");
    expect(applyPendingMoves(tasks, {})).toBe(tasks);
  });
});

describe("matchesBoardFilter", () => {
  const linked = task("t42", {
    number: 42, title: "Fix sync drift", priority: "urgent", labels: ["sync", "bug"], assignee: "user:ana",
    externalLink: { provider: "linear", key: "ENG-77", url: "https://linear.app/x/issue/ENG-77" }, branch: "task/mos-42-fix-sync",
  });

  it("hides canceled and archived tasks unless asked for", () => {
    expect(matchesBoardFilter(task("t1", { status: "canceled" }), EMPTY_BOARD_FILTER)).toBe(false);
    expect(matchesBoardFilter(task("t1", { archivedAt: "2026-11-02T00:00:00.000Z" }), EMPTY_BOARD_FILTER)).toBe(false);
    expect(matchesBoardFilter(task("t1", { status: "canceled" }), { ...EMPTY_BOARD_FILTER, showCanceled: true })).toBe(true);
    expect(matchesBoardFilter(task("t1", { archivedAt: "2026-11-02T00:00:00.000Z" }), { ...EMPTY_BOARD_FILTER, showArchived: true })).toBe(true);
  });

  it("matches every selected facet", () => {
    expect(matchesBoardFilter(linked, { ...EMPTY_BOARD_FILTER, priorities: ["urgent", "high"] })).toBe(true);
    expect(matchesBoardFilter(linked, { ...EMPTY_BOARD_FILTER, priorities: ["low"] })).toBe(false);
    expect(matchesBoardFilter(linked, { ...EMPTY_BOARD_FILTER, labels: ["bug"] })).toBe(true);
    expect(matchesBoardFilter(linked, { ...EMPTY_BOARD_FILTER, labels: ["design"] })).toBe(false);
    expect(matchesBoardFilter(linked, { ...EMPTY_BOARD_FILTER, assignees: ["user:ana"] })).toBe(true);
    expect(matchesBoardFilter(linked, { ...EMPTY_BOARD_FILTER, assignees: ["unassigned"] })).toBe(false);
    expect(matchesBoardFilter(task("t2"), { ...EMPTY_BOARD_FILTER, assignees: ["unassigned"] })).toBe(true);
    expect(matchesBoardFilter(linked, { ...EMPTY_BOARD_FILTER, statuses: ["done"] })).toBe(false);
  });

  it("searches title, board key, Linear key, label and branch, ignoring case", () => {
    for (const search of ["sync drift", "mos-42", "eng-77", "BUG", "task/mos-42"]) {
      expect(matchesBoardFilter(linked, { ...EMPTY_BOARD_FILTER, search })).toBe(true);
    }
    expect(matchesBoardFilter(linked, { ...EMPTY_BOARD_FILTER, search: "billing" })).toBe(false);
  });

  it("reports whether any filter narrows the board", () => {
    expect(boardFilterIsActive(EMPTY_BOARD_FILTER)).toBe(false);
    expect(boardFilterIsActive({ ...EMPTY_BOARD_FILTER, search: "  " })).toBe(false);
    expect(boardFilterIsActive({ ...EMPTY_BOARD_FILTER, labels: ["bug"] })).toBe(true);
  });
});

describe("rollUpTaskAgentStatus", () => {
  it("shows the most urgent session: blocked > done > working > idle", () => {
    expect(rollUpTaskAgentStatus([])).toBeUndefined();
    expect(rollUpTaskAgentStatus([session("idle")])).toBe("idle");
    expect(rollUpTaskAgentStatus([session("idle"), session("working")])).toBe("working");
    expect(rollUpTaskAgentStatus([session("working"), session("done")])).toBe("done");
    expect(rollUpTaskAgentStatus([session("done"), session("blocked"), session("working")])).toBe("blocked");
  });

  it("treats an errored agent as needing the person like a blocked one", () => {
    expect(rollUpTaskAgentStatus([session("done"), session("error")])).toBe("error");
  });
});

describe("sortTasksForList", () => {
  const tasks = [
    task("t1", { number: 1, priority: "low", status: "done", title: "beta", updatedAt: "2026-11-03T00:00:00.000Z" }),
    task("t2", { number: 2, priority: "urgent", status: "backlog", title: "alpha", updatedAt: "2026-11-01T00:00:00.000Z" }),
    task("t3", { number: 3, priority: "high", status: "in_progress", title: "gamma", updatedAt: "2026-11-02T00:00:00.000Z" }),
  ];
  const ids = (list: readonly ProjectTask[]) => list.map((t) => t.id);

  it("sorts by key, title, status order, priority weight and recency", () => {
    expect(ids(sortTasksForList(tasks, { column: "key", direction: "desc" }))).toEqual(["t3", "t2", "t1"]);
    expect(ids(sortTasksForList(tasks, { column: "title", direction: "asc" }))).toEqual(["t2", "t1", "t3"]);
    expect(ids(sortTasksForList(tasks, { column: "status", direction: "asc" }))).toEqual(["t2", "t3", "t1"]);
    expect(ids(sortTasksForList(tasks, { column: "priority", direction: "desc" }))).toEqual(["t2", "t3", "t1"]);
    expect(ids(sortTasksForList(tasks, { column: "updated", direction: "desc" }))).toEqual(["t1", "t3", "t2"]);
  });

  it("does not reorder the caller's array", () => {
    sortTasksForList(tasks, { column: "title", direction: "asc" });
    expect(ids(tasks)).toEqual(["t1", "t2", "t3"]);
  });
});

describe("keyboardMoveTarget", () => {
  const fiveColumns = ["backlog", "todo", "in_progress", "in_review", "done"] as const;
  const groups = groupTasksByStatus([
    task("t1", { status: "todo", rank: "a" }), task("t2", { status: "todo", rank: "b" }),
    task("t3", { status: "in_progress", rank: "a" }),
  ]);

  it("moves a card up and down inside its column", () => {
    expect(keyboardMoveTarget(groups, fiveColumns, "t2", "up")).toEqual({ status: "todo", index: 0 });
    expect(keyboardMoveTarget(groups, fiveColumns, "t1", "down")).toEqual({ status: "todo", index: 1 });
    expect(keyboardMoveTarget(groups, fiveColumns, "t1", "up")).toBeNull();
    expect(keyboardMoveTarget(groups, fiveColumns, "t2", "down")).toBeNull();
  });

  it("moves a card to the neighbouring column at the same height, clamped", () => {
    expect(keyboardMoveTarget(groups, fiveColumns, "t2", "right")).toEqual({ status: "in_progress", index: 1 });
    expect(keyboardMoveTarget(groups, fiveColumns, "t1", "left")).toEqual({ status: "backlog", index: 0 });
    expect(keyboardMoveTarget(groups, fiveColumns, "t3", "left")).toEqual({ status: "todo", index: 0 });
    expect(keyboardMoveTarget(groupTasksByStatus([task("t5", { status: "backlog" })]), fiveColumns, "t5", "left")).toBeNull();
    expect(keyboardMoveTarget(groupTasksByStatus([task("t6", { status: "done" })]), fiveColumns, "t6", "right")).toBeNull();
  });

  it("moves canceled cards when the Canceled column is shown", () => {
    const withCanceled = [...fiveColumns, "canceled"] as const;
    const columns = groupTasksByStatus([
      task("t7", { status: "canceled", rank: "a" }), task("t8", { status: "canceled", rank: "b" }), task("t9", { status: "done" }),
    ]);
    expect(keyboardMoveTarget(columns, withCanceled, "t7", "down")).toEqual({ status: "canceled", index: 1 });
    expect(keyboardMoveTarget(columns, withCanceled, "t8", "left")).toEqual({ status: "done", index: 1 });
    expect(keyboardMoveTarget(columns, withCanceled, "t9", "right")).toEqual({ status: "canceled", index: 0 });
    expect(keyboardMoveTarget(columns, withCanceled, "t8", "right")).toBeNull();
  });

  it("steps over columns that are filtered out of the board", () => {
    const shown = ["todo", "done"] as const;
    const columns = groupTasksByStatus([task("t1", { status: "todo" })]);
    expect(keyboardMoveTarget(columns, shown, "t1", "right")).toEqual({ status: "done", index: 0 });
    expect(keyboardMoveTarget(columns, shown, "t1", "left")).toBeNull();
  });
});

describe("planMove when the rank room has run out", () => {
  it("still names both neighbours so the server can respace the column", () => {
    const tight = [task("a1", { rank: "a" }), task("a2", { rank: `a${"0".repeat(126)}1` })];
    const plan = planMove(tight, "t9", 1);
    expect(plan).toMatchObject({ afterTaskId: "a1", beforeTaskId: "a2" });
    expect(typeof plan.rank).toBe("string");
  });
});
