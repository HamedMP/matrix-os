import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  countByView,
  filterTasks,
  nextRecurrence,
  normalizeTask,
  projectNames,
  sortTasks,
  type Task,
  type View,
} from "../../home/apps/todo/src/todo-model";

function makeTask(partial: Partial<Task> = {}): Task {
  return normalizeTask({
    id: partial.id ?? crypto.randomUUID(),
    title: partial.title ?? "Task",
    notes: partial.notes ?? "",
    due: partial.due ?? null,
    priority: partial.priority ?? 0,
    project: partial.project ?? null,
    status: partial.status ?? "open",
    recur: partial.recur ?? null,
    created_at: partial.created_at ?? "2026-05-31T00:00:00.000Z",
  })!;
}

const NOW = new Date("2026-05-31T12:00:00.000Z"); // Sunday
const REPO_ROOT = join(__dirname, "..", "..");

describe("normalizeTask", () => {
  it("coerces loose db rows into typed tasks", () => {
    const t = normalizeTask({
      id: "a",
      title: " Buy milk ",
      priority: "2",
      status: "done",
      due: "2026-06-01T00:00:00.000Z",
    });
    expect(t).not.toBeNull();
    expect(t!.title).toBe("Buy milk");
    expect(t!.priority).toBe(2);
    expect(t!.status).toBe("done");
    expect(t!.due).toBe("2026-06-01T00:00:00.000Z");
  });

  it("clamps priority to 0-3 and rejects empty titles", () => {
    expect(normalizeTask({ id: "x", title: "   " })).toBeNull();
    expect(normalizeTask({ id: "x", title: "ok", priority: 99 })!.priority).toBe(3);
    expect(normalizeTask({ id: "x", title: "ok", priority: -5 })!.priority).toBe(0);
  });

  it("coerces numeric ids to stable string ids", () => {
    expect(normalizeTask({ id: 42, title: "Numeric id" })?.id).toBe("42");
  });

  it("hydrates legacy task rows from the previous default app schema", () => {
    const task = normalizeTask({
      id: "legacy",
      text: "Ship migration",
      done: true,
      category: "Launch",
      priority: "high",
      due: "2026-06-02T09:00:00.000Z",
    });

    expect(task).toMatchObject({
      id: "legacy",
      title: "Ship migration",
      status: "done",
      project: "Launch",
      priority: 3,
      due: "2026-06-02T09:00:00.000Z",
    });
  });
});

describe("todo manifest schema", () => {
  it("keeps legacy task columns declared during the schema transition", () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "home", "apps", "todo", "matrix.json"), "utf-8"),
    ) as { storage?: { tables?: { tasks?: { columns?: Record<string, string> } } } };
    const columns = manifest.storage?.tables?.tasks?.columns ?? {};

    expect(columns).toMatchObject({
      title: "text",
      text: "text",
      status: "text",
      done: "boolean",
      priority: "text",
      project: "text",
      category: "text",
    });
  });
});

describe("filterTasks", () => {
  const overdue = makeTask({ id: "1", title: "overdue", due: "2026-05-30T09:00:00.000Z" });
  const today = makeTask({ id: "2", title: "today", due: "2026-05-31T18:00:00.000Z" });
  const tomorrow = makeTask({ id: "3", title: "tomorrow", due: "2026-06-01T09:00:00.000Z" });
  const noDate = makeTask({ id: "4", title: "inbox-item", due: null });
  const projItem = makeTask({ id: "5", title: "proj", project: "Work", due: null });
  const done = makeTask({ id: "6", title: "done", status: "done", due: "2026-05-31T08:00:00.000Z" });
  const all = [overdue, today, tomorrow, noDate, projItem, done];

  it("Inbox shows open tasks with no project", () => {
    const ids = filterTasks(all, "inbox", NOW).map((t) => t.id);
    expect(ids).toContain("4");
    expect(ids).not.toContain("5"); // has project
    expect(ids).not.toContain("6"); // done
  });

  it("Today shows open tasks due today or overdue", () => {
    const ids = filterTasks(all, "today", NOW).map((t) => t.id);
    expect(ids).toContain("1"); // overdue
    expect(ids).toContain("2"); // today
    expect(ids).not.toContain("3"); // tomorrow
    expect(ids).not.toContain("6"); // done
  });

  it("Upcoming shows open tasks due after today", () => {
    const ids = filterTasks(all, "upcoming", NOW).map((t) => t.id);
    expect(ids).toContain("3");
    expect(ids).not.toContain("1");
    expect(ids).not.toContain("2");
    expect(ids).not.toContain("4"); // no due date
  });

  it("project view filters by project name", () => {
    const ids = filterTasks(all, { kind: "project", project: "Work" }, NOW).map((t) => t.id);
    expect(ids).toEqual(["5"]);
  });
});

describe("countByView", () => {
  it("returns per-view open counts", () => {
    const tasks = [
      makeTask({ id: "1", due: "2026-05-31T18:00:00.000Z" }),
      makeTask({ id: "2", due: "2026-06-02T18:00:00.000Z" }),
      makeTask({ id: "3", due: null }),
      makeTask({ id: "4", status: "done", due: "2026-05-31T18:00:00.000Z" }),
    ];
    const counts = countByView(tasks, NOW);
    expect(counts.inbox).toBe(3);
    expect(counts.today).toBe(1);
    expect(counts.upcoming).toBe(1);
  });
});

describe("projectNames", () => {
  it("only includes projects with open tasks", () => {
    const tasks = [
      makeTask({ id: "open", project: "Work", status: "open" }),
      makeTask({ id: "done", project: "Archive", status: "done" }),
    ];

    expect(projectNames(tasks)).toEqual(["Work"]);
  });
});

describe("sortTasks", () => {
  it("orders by priority desc then due asc then created", () => {
    const a = makeTask({ id: "a", priority: 1, due: "2026-06-02T00:00:00.000Z" });
    const b = makeTask({ id: "b", priority: 3, due: null });
    const c = makeTask({ id: "c", priority: 1, due: "2026-06-01T00:00:00.000Z" });
    const sorted = sortTasks([a, b, c]).map((t) => t.id);
    expect(sorted[0]).toBe("b"); // highest priority
    expect(sorted.slice(1)).toEqual(["c", "a"]); // same prio, earlier due first
  });
});

describe("nextRecurrence", () => {
  it("daily adds one day", () => {
    expect(nextRecurrence("daily", new Date("2026-05-31T09:00:00.000Z"))).toBe(
      "2026-06-01T09:00:00.000Z",
    );
  });

  it("weekly adds seven days", () => {
    expect(nextRecurrence("weekly", new Date("2026-05-31T09:00:00.000Z"))).toBe(
      "2026-06-07T09:00:00.000Z",
    );
  });

  it("weekdays skips weekend (Fri -> Mon)", () => {
    // 2026-06-05 is a Friday
    expect(nextRecurrence("weekdays", new Date("2026-06-05T09:00:00.000Z"))).toBe(
      "2026-06-08T09:00:00.000Z",
    );
  });

  it("weekdays Sunday -> Monday", () => {
    // 2026-05-31 is a Sunday
    expect(nextRecurrence("weekdays", new Date("2026-05-31T09:00:00.000Z"))).toBe(
      "2026-06-01T09:00:00.000Z",
    );
  });

  it("returns null for no recurrence", () => {
    expect(nextRecurrence(null, NOW)).toBeNull();
    expect(nextRecurrence("nonsense" as never, NOW)).toBeNull();
  });
});

// type export sanity
const _v: View = "inbox";
void _v;
