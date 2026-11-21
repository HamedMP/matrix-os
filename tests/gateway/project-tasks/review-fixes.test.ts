import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kysely } from "kysely";
import { Hono } from "hono";
import { ProjectTaskErrorSchema } from "@matrix-os/contracts/project-tasks";
import { createTestPGlite } from "../../helpers/pglite-test-helper.js";
import { bootstrapProjectTaskDatabase, type ProjectTaskDatabase } from "../../../packages/gateway/src/project-tasks/database.js";
import { ProjectTaskRepository } from "../../../packages/gateway/src/project-tasks/repository.js";
import { ProjectTaskCommentRepository } from "../../../packages/gateway/src/project-tasks/comments.js";
import { ProjectTaskService } from "../../../packages/gateway/src/project-tasks/service.js";
import { createProjectTaskRoutes } from "../../../packages/gateway/src/project-tasks/routes.js";
import type { TaskRecord } from "../../../packages/gateway/src/task-manager.js";

const OWNER = { type: "user" as const, id: "user_owner" };
const SCOPE = { ownerId: OWNER.id, projectId: "proj_demo" };

describe("board review fixes", () => {
  let db: Kysely<ProjectTaskDatabase>;
  let repository: ProjectTaskRepository;
  let legacyResult: { ok: true; tasks: TaskRecord[]; nextCursor: null } | { ok: false; status: number; error: { code: string; message: string } };
  let legacyCalls: number;
  let admitted: number;
  let fenceOpen: boolean;
  let app: Hono;

  beforeEach(async () => {
    db = new Kysely<ProjectTaskDatabase>({ dialect: (await createTestPGlite()).dialect });
    await bootstrapProjectTaskDatabase(db);
    repository = new ProjectTaskRepository(db);
    legacyResult = { ok: true, tasks: [], nextCursor: null };
    legacyCalls = 0;
    admitted = 0;
    fenceOpen = true;
    const service = new ProjectTaskService({
      repository,
      comments: new ProjectTaskCommentRepository(db),
      members: async () => [],
      projects: { getProject: async (slug: string) => ({ ok: true as const, project: { id: "proj_demo", slug } as never }) },
      legacyTasks: { listTasks: async () => { legacyCalls += 1; return legacyResult; } },
      publish: async () => {},
      admit: async (_caller, _project, write) => {
        admitted += 1;
        if (!fenceOpen) throw new Error("fenced");
        return write();
      },
    });
    app = new Hono();
    app.route("/", createProjectTaskRoutes({ service, getOwnerScope: () => OWNER }));
  });
  afterEach(async () => { await db.destroy(); });

  it("keeps creating cards at the top long after the rank space between two cards runs out", async () => {
    await repository.ensureBoard(SCOPE, "BD");
    for (let index = 0; index < 900; index += 1) {
      await repository.createTask(SCOPE, { title: `t${index}`, status: "todo", id: `task_${index}`, clientRequestId: `req_${index}`, payloadHash: "a".repeat(64) }, "user:owner");
    }
    const ranks = (await db.selectFrom("project_tasks").select(["id", "rank"]).orderBy("rank").execute());
    expect(new Set(ranks.map((row) => row.rank)).size).toBe(900);
    expect(ranks[0]?.id).toBe("task_899");
    expect(Math.max(...ranks.map((row) => row.rank.length))).toBeLessThanOrEqual(128);
  }, 60_000);

  it("gives a second move into an already-used gap its own position (stale neighbours)", async () => {
    await repository.ensureBoard(SCOPE, "BD");
    const make = (id: string, status: "todo" | "backlog") => repository.createTask(SCOPE, { title: id, status, id, clientRequestId: `req_${id}`, payloadHash: "a".repeat(64) }, "user:owner");
    await make("task_b", "todo");
    await make("task_a", "todo");
    await make("task_x", "backlog");
    await make("task_y", "backlog");
    // Both clients saw the same neighbours; the board lock serializes them on Postgres, and the
    // second must then land next to the first instead of reusing its rank.
    for (const id of ["task_x", "task_y"]) {
      await repository.moveTask(SCOPE, id, { status: "todo", afterTaskId: "task_a", beforeTaskId: "task_b" }, "user:owner");
    }
    const ranks = (await db.selectFrom("project_tasks").select("rank").where("status", "=", "todo").execute()).map((row) => row.rank);
    expect(new Set(ranks).size).toBe(4);
  });

  it("does not mark a failed legacy import as done, and retries it on the next open", async () => {
    legacyResult = { ok: false, status: 503, error: { code: "unavailable", message: "x" } };
    const failed = await app.request("/api/projects/demo/tasks");
    expect(failed.status).toBe(503);
    expect(ProjectTaskErrorSchema.parse(await failed.json()).error.code).toBe("board_unavailable");
    legacyResult = { ok: true, nextCursor: null, tasks: [{
      id: "task_old", projectSlug: "demo", title: "Old", status: "todo", priority: "low", order: 0, previewIds: [],
      createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    }] };
    const retried = await app.request("/api/projects/demo/tasks");
    expect(retried.status).toBe(200);
    expect(((await retried.json()) as { tasks: Array<{ id: string }> }).tasks.map((task) => task.id)).toEqual(["task_old"]);
    expect(legacyCalls).toBe(2);
  });

  it("prepares the board behind the project fence, even for a read, and writes nothing when fenced", async () => {
    fenceOpen = false;
    expect((await app.request("/api/projects/demo/tasks")).status).toBe(503);
    expect(await db.selectFrom("project_board_settings").selectAll().execute()).toEqual([]);
    fenceOpen = true;
    expect((await app.request("/api/projects/demo/tasks")).status).toBe(200);
    expect((await app.request("/api/projects/demo/tasks")).status).toBe(200);
    expect(admitted).toBe(2);
  });

});
