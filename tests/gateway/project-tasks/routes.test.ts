import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kysely } from "kysely";
import { Hono } from "hono";
import { ListTasksResponseSchema, ProjectTaskErrorSchema, TaskResponseSchema, type ProjectTask } from "@matrix-os/contracts/project-tasks";
import { createTestPGlite } from "../../helpers/pglite-test-helper.js";
import { bootstrapProjectTaskDatabase, type ProjectTaskDatabase } from "../../../packages/gateway/src/project-tasks/database.js";
import { ProjectTaskRepository } from "../../../packages/gateway/src/project-tasks/repository.js";
import { ProjectTaskCommentRepository } from "../../../packages/gateway/src/project-tasks/comments.js";
import { ProjectTaskService, type TaskEventPublisher } from "../../../packages/gateway/src/project-tasks/service.js";
import { createProjectTaskRoutes } from "../../../packages/gateway/src/project-tasks/routes.js";
import type { TaskRecord } from "../../../packages/gateway/src/task-manager.js";

const OWNER = { type: "user" as const, id: "user_owner" };
const PROJECT = { id: "proj_demo", slug: "board-demo" };

function legacy(records: TaskRecord[] = []) {
  return {
    calls: 0,
    async listTasks() {
      this.calls += 1;
      return { ok: true as const, tasks: records, nextCursor: null };
    },
  };
}

function record(id: string, overrides: Partial<TaskRecord>): TaskRecord {
  return {
    id, projectSlug: PROJECT.slug, title: `Legacy ${id}`, status: "todo", priority: "normal", order: 0, previewIds: [],
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z", ...overrides,
  };
}

describe("project task routes", () => {
  let db: Kysely<ProjectTaskDatabase>;
  let app: Hono;
  let events: Parameters<TaskEventPublisher>[0][];
  let legacyTasks: ReturnType<typeof legacy>;

  async function build(records: TaskRecord[] = [], withService = true) {
    db = new Kysely<ProjectTaskDatabase>({ dialect: (await createTestPGlite()).dialect });
    await bootstrapProjectTaskDatabase(db);
    events = [];
    legacyTasks = legacy(records);
    const service = new ProjectTaskService({
      repository: new ProjectTaskRepository(db),
      comments: new ProjectTaskCommentRepository(db),
      members: async () => [{ actor: "user:user_owner", name: "Owner", handle: "owner" }],
      projects: {
        getProject: async (slug: string) => (slug === PROJECT.slug
          ? { ok: true as const, project: { id: PROJECT.id, slug, name: "Board demo" } as never }
          : { ok: false as const, status: 404, error: { code: "not_found", message: "Project was not found" } }),
      },
      legacyTasks,
      publish: async (event) => { events.push(event); },
    });
    app = new Hono();
    app.route("/", createProjectTaskRoutes({ service: withService ? service : null, getOwnerScope: () => OWNER }));
  }

  function call(method: string, path: string, body?: unknown) {
    return app.request(`/api/projects/${PROJECT.slug}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  }

  async function create(title: string, extra: Record<string, unknown> = {}): Promise<ProjectTask> {
    const response = await call("POST", "/tasks", { title, clientRequestId: `req_${title.replace(/\W/g, "_")}`, ...extra });
    expect(response.status).toBe(201);
    return TaskResponseSchema.parse(await response.json()).task;
  }

  async function list(query = ""): Promise<ProjectTask[]> {
    const response = await call("GET", `/tasks${query}`);
    expect(response.status).toBe(200);
    return ListTasksResponseSchema.parse(await response.json()).tasks;
  }

  beforeEach(async () => { await build(); });
  afterEach(async () => { await db.destroy(); });

  it("applies the schema once", async () => {
    expect((await bootstrapProjectTaskDatabase(db)).applied).toEqual([]);
  });

  it("creates numbered tasks at the top of their column and signals the change", async () => {
    const first = await create("First");
    const second = await create("Second");
    expect(first).toMatchObject({ number: 1, key: "BD-1", status: "backlog", priority: "none", createdBy: "user:user_owner", revision: 1 });
    expect(second.number).toBe(2);
    expect(second.rank < first.rank).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["task.created", "task.created"]);
  });

  it("returns the first result for a repeated create and rejects a reused request id with another payload", async () => {
    const body = { title: "Once", clientRequestId: "req_once" };
    const first = await call("POST", "/tasks", body);
    const again = await call("POST", "/tasks", body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(TaskResponseSchema.parse(await again.json()).task.id).toBe(TaskResponseSchema.parse(await first.json()).task.id);
    expect((await call("POST", "/tasks", { ...body, title: "Different" })).status).toBe(400);
    expect(await list()).toHaveLength(1);
  });

  it("filters by status, assignee, label and text, and pages by cursor", async () => {
    await create("Billing bug", { status: "todo", labels: ["bug"], assignee: "user:ana" });
    await create("Docs", { status: "todo" });
    await create("Spec", { status: "done" });
    expect((await list("?status=todo")).map((task) => task.title).sort()).toEqual(["Billing bug", "Docs"]);
    expect((await list("?assignee=user:ana")).map((task) => task.title)).toEqual(["Billing bug"]);
    expect((await list("?assignee=unassigned")).map((task) => task.title).sort()).toEqual(["Docs", "Spec"]);
    expect((await list("?label=bug")).map((task) => task.title)).toEqual(["Billing bug"]);
    expect((await list("?q=billing")).map((task) => task.title)).toEqual(["Billing bug"]);
    expect((await list("?q=BD-3")).map((task) => task.title)).toEqual(["Spec"]);
    expect((await list("?q=100%25")).length).toBe(0);
    const page = ListTasksResponseSchema.parse(await (await call("GET", "/tasks?limit=2")).json());
    expect(page.tasks.map((task) => task.number)).toEqual([1, 2]);
    const rest = ListTasksResponseSchema.parse(await (await call("GET", `/tasks?limit=2&cursor=${page.nextCursor}`)).json());
    expect(rest.tasks.map((task) => task.number)).toEqual([3]);
    expect(rest.nextCursor).toBeNull();
  });

  it("rejects a stale edit with the current task and keeps the row unchanged", async () => {
    const task = await create("Edit me");
    const first = await call("PATCH", `/tasks/${task.id}`, { baseRevision: 1, title: "Edited", labels: ["ux"] });
    expect(first.status).toBe(200);
    const stale = await call("PATCH", `/tasks/${task.id}`, { baseRevision: 1, title: "Lost update" });
    expect(stale.status).toBe(409);
    const body = ProjectTaskErrorSchema.parse(await stale.json());
    expect(body.error.code).toBe("task_revision_conflict");
    expect(body.task).toMatchObject({ title: "Edited", revision: 2, labels: ["ux"] });
    const activity = await (await call("GET", `/tasks/${task.id}/activity`)).json() as { activity: Array<{ kind: string }> };
    expect(activity.activity.map((entry) => entry.kind)).toEqual(["created", "renamed", "labels_changed"]);
  });

  it("never takes an actor from the body", async () => {
    const response = await call("POST", "/tasks", { title: "x", clientRequestId: "req_x", createdBy: "user:someone_else" });
    expect(response.status).toBe(400);
  });

  it("moves a card between named neighbours and logs the status change", async () => {
    const a = await create("A", { status: "todo" });
    const b = await create("B", { status: "todo" });
    const moving = await create("Moving");
    // Column order is newest first: B, A.
    const response = await call("POST", `/tasks/${moving.id}/move`, { status: "todo", afterTaskId: b.id, beforeTaskId: a.id });
    expect(response.status).toBe(200);
    const moved = TaskResponseSchema.parse(await response.json()).task;
    expect(moved.status).toBe("todo");
    expect(moved.rank > b.rank && moved.rank < a.rank).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "task.moved", taskId: moving.id });
    const activity = await (await call("GET", `/tasks/${moving.id}/activity`)).json() as { activity: Array<{ summary: string }> };
    expect(activity.activity.at(-1)?.summary).toBe("Backlog → To do");
  });

  it("lets concurrent moves both land, last writer wins, with valid ranks", async () => {
    const anchor = await create("Anchor", { status: "in_progress" });
    const x = await create("X");
    const y = await create("Y");
    const results = await Promise.all([
      call("POST", `/tasks/${x.id}/move`, { status: "in_progress", afterTaskId: anchor.id }),
      call("POST", `/tasks/${y.id}/move`, { status: "in_progress", afterTaskId: anchor.id }),
      call("POST", `/tasks/${x.id}/move`, { status: "done" }),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200, 200]);
    const tasks = await list();
    expect(tasks.find((task) => task.id === y.id)?.status).toBe("in_progress");
    expect(new Set(tasks.filter((task) => task.status === "in_progress").map((task) => task.rank)).size).toBe(2);
  });

  it("falls back to the column top when a named neighbour has moved away", async () => {
    const gone = await create("Gone", { status: "done" });
    const top = await create("Top", { status: "todo" });
    const moving = await create("Moving");
    const moved = TaskResponseSchema.parse(await (await call("POST", `/tasks/${moving.id}/move`, { status: "todo", afterTaskId: gone.id })).json()).task;
    expect(moved.rank < top.rank).toBe(true);
  });

  it("archives out of the default list, restores, and soft-deletes once", async () => {
    const parent = await create("Parent");
    const child = await create("Child", { parentTaskId: parent.id });
    expect((await call("POST", `/tasks/${parent.id}/archive`, {})).status).toBe(200);
    expect((await list()).map((task) => task.id)).toEqual([child.id]);
    expect((await list("?includeArchived=true")).length).toBe(2);
    expect((await call("POST", `/tasks/${parent.id}/unarchive`, {})).status).toBe(200);
    expect((await call("DELETE", `/tasks/${parent.id}`, {})).status).toBe(200);
    expect((await call("DELETE", `/tasks/${parent.id}`, {})).status).toBe(404);
    expect((await call("GET", `/tasks/${parent.id}`)).status).toBe(404);
    expect((await list()).find((task) => task.id === child.id)?.parentTaskId).toBeNull();
  });

  it("refuses a parent that would loop", async () => {
    const a = await create("A");
    const b = await create("B", { parentTaskId: a.id });
    const response = await call("PATCH", `/tasks/${a.id}`, { baseRevision: 1, parentTaskId: b.id });
    expect(response.status).toBe(400);
    expect(ProjectTaskErrorSchema.parse(await response.json()).error.code).toBe("task_relation_invalid");
  });

  it("validates params and bounds bodies", async () => {
    expect((await app.request("/api/projects/..%2Fetc/tasks")).status).toBe(400);
    expect((await call("GET", "/tasks/not-a-task")).status).toBe(400);
    expect((await call("GET", "/tasks/task_missing")).status).toBe(404);
    expect((await call("POST", "/tasks", { title: "x".repeat(300_000), clientRequestId: "req_big" })).status).toBe(413);
    expect((await app.request("/api/projects/other/tasks")).status).toBe(404);
  });

  it("answers 503, not 404, when the owner database is unavailable", async () => {
    await build([], false);
    const response = await call("GET", "/tasks");
    expect(response.status).toBe(503);
    expect(ProjectTaskErrorSchema.parse(await response.json()).error.code).toBe("board_unavailable");
  });

  it("imports the legacy task files once with the spec's status mapping", async () => {
    await db.destroy();
    await build([
      record("task_a", { status: "running", order: 2 }),
      record("task_b", { status: "blocked", order: 1, linkedWorktreeId: "wt_1" }),
      record("task_c", { status: "complete" }),
      record("task_d", { status: "archived", archivedAt: "2026-10-05T00:00:00.000Z" }),
      record("task_e", { status: "waiting", parentTaskId: "task_a", order: 3 }),
    ]);
    const tasks = await list("?includeArchived=true");
    const byId = Object.fromEntries(tasks.map((task) => [task.id, task]));
    expect(byId.task_a?.status).toBe("in_progress");
    expect(byId.task_b).toMatchObject({ status: "in_progress", labels: ["blocked"], worktreeId: "wt_1" });
    expect(byId.task_c?.status).toBe("done");
    expect(byId.task_d).toMatchObject({ status: "done", archivedAt: "2026-10-05T00:00:00.000Z" });
    expect(byId.task_e?.parentTaskId).toBe("task_a");
    expect(byId.task_b!.rank < byId.task_a!.rank).toBe(true);
    await list();
    expect(legacyTasks.calls).toBe(1);
    expect(await list("?includeArchived=true")).toHaveLength(5);
  });
});
