import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Kysely } from "kysely";
import { Hono } from "hono";
import { CommentResponseSchema, ListCommentsResponseSchema, ProjectTaskErrorSchema, TaskResponseSchema, type ProjectTask } from "@matrix-os/contracts/project-tasks";
import { createTestPGlite } from "../../helpers/pglite-test-helper.js";
import { bootstrapProjectTaskDatabase, type ProjectTaskDatabase } from "../../../packages/gateway/src/project-tasks/database.js";
import { ProjectTaskRepository } from "../../../packages/gateway/src/project-tasks/repository.js";
import { ProjectTaskCommentRepository } from "../../../packages/gateway/src/project-tasks/comments.js";
import { ProjectTaskService } from "../../../packages/gateway/src/project-tasks/service.js";
import { createProjectTaskRoutes } from "../../../packages/gateway/src/project-tasks/routes.js";
import type { TaskNotification } from "../../../packages/gateway/src/project-tasks/notifications.js";

const OWNER = { type: "user" as const, id: "user_owner" };
const MEMBERS = [
  { actor: "user:user_owner" as const, name: "Owner", handle: "owner" },
  { actor: "user:user_ana" as const, name: "Ana", handle: "ana" },
];

describe("task comments, blockers and members", () => {
  let db: Kysely<ProjectTaskDatabase>;
  let app: Hono;
  let actor: string;
  let notifications: TaskNotification[];
  let events: string[];

  beforeEach(async () => {
    db = new Kysely<ProjectTaskDatabase>({ dialect: (await createTestPGlite()).dialect });
    await bootstrapProjectTaskDatabase(db);
    actor = "user:user_owner";
    notifications = [];
    events = [];
    const service = new ProjectTaskService({
      repository: new ProjectTaskRepository(db),
      comments: new ProjectTaskCommentRepository(db),
      members: async () => MEMBERS,
      notify: async (notification) => { notifications.push(notification); },
      projects: { getProject: async (slug: string) => ({ ok: true as const, project: { id: "proj_demo", slug } as never }) },
      legacyTasks: { listTasks: async () => ({ ok: true as const, tasks: [], nextCursor: null }) },
      publish: async (event) => { events.push(event.type); },
    });
    app = new Hono();
    app.route("/", createProjectTaskRoutes({ service, getOwnerScope: () => OWNER, getActor: () => actor as never }));
  });
  afterEach(async () => { await db.destroy(); });

  const call = (method: string, path: string, body?: unknown) => app.request(`/api/projects/demo${path}`, {
    method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

  async function create(title: string, extra: Record<string, unknown> = {}): Promise<ProjectTask> {
    return TaskResponseSchema.parse(await (await call("POST", "/tasks", { title, clientRequestId: `req_${title}`, ...extra })).json()).task;
  }

  it("adds comments in order, counts them without bumping the revision, and signals subscribers", async () => {
    const task = await create("Commented");
    for (const body of ["first", "second", "third"]) expect((await call("POST", `/tasks/${task.id}/comments`, { body })).status).toBe(201);
    const page = ListCommentsResponseSchema.parse(await (await call("GET", `/tasks/${task.id}/comments?limit=2`)).json());
    expect(page.comments.map((comment) => comment.body)).toEqual(["first", "second"]);
    const rest = ListCommentsResponseSchema.parse(await (await call("GET", `/tasks/${task.id}/comments?cursor=${page.nextCursor}`)).json());
    expect(rest.comments.map((comment) => comment.body)).toEqual(["third"]);
    const after = TaskResponseSchema.parse(await (await call("GET", `/tasks/${task.id}`)).json()).task;
    expect(after).toMatchObject({ commentCount: 3, revision: 1 });
    expect(events.filter((type) => type === "task.comment_added")).toHaveLength(3);
  });

  it("lets only the author edit or delete a comment", async () => {
    const task = await create("Owned");
    const comment = CommentResponseSchema.parse(await (await call("POST", `/tasks/${task.id}/comments`, { body: "mine" })).json()).comment;
    actor = "user:user_ana";
    const forbidden = await call("PATCH", `/tasks/${task.id}/comments/${comment.id}`, { body: "hijack" });
    expect(forbidden.status).toBe(403);
    expect((await call("DELETE", `/tasks/${task.id}/comments/${comment.id}`, {})).status).toBe(403);
    actor = "user:user_owner";
    const edited = CommentResponseSchema.parse(await (await call("PATCH", `/tasks/${task.id}/comments/${comment.id}`, { body: "edited" })).json()).comment;
    expect(edited.body).toBe("edited");
    expect(edited.editedAt).not.toBeNull();
    expect((await call("DELETE", `/tasks/${task.id}/comments/${comment.id}`, {})).status).toBe(200);
    expect((await call("DELETE", `/tasks/${task.id}/comments/${comment.id}`, {})).status).toBe(404);
    expect(TaskResponseSchema.parse(await (await call("GET", `/tasks/${task.id}`)).json()).task.commentCount).toBe(0);
  });

  it("bounds comment bodies", async () => {
    const task = await create("Bounded");
    expect((await call("POST", `/tasks/${task.id}/comments`, { body: "   " })).status).toBe(400);
    expect((await call("POST", `/tasks/${task.id}/comments`, { body: "x".repeat(10_001) })).status).toBe(400);
    expect((await call("POST", "/tasks/task_missing/comments", { body: "hi" })).status).toBe(404);
  });

  it("records blockers, rejects unknown or self blockers, and drops them with a deleted task", async () => {
    const blocker = await create("Blocker");
    const blocked = await create("Blocked");
    const updated = TaskResponseSchema.parse(await (await call("PATCH", `/tasks/${blocked.id}`, { baseRevision: 1, blockedBy: [blocker.id] })).json()).task;
    expect(updated.blockedBy).toEqual([blocker.id]);
    const self = await call("PATCH", `/tasks/${blocked.id}`, { baseRevision: 2, blockedBy: [blocked.id] });
    expect(ProjectTaskErrorSchema.parse(await self.json()).error.code).toBe("task_relation_invalid");
    const unknown = await call("PATCH", `/tasks/${blocked.id}`, { baseRevision: 2, blockedBy: ["task_nope"] });
    expect(unknown.status).toBe(400);
    expect((await call("DELETE", `/tasks/${blocker.id}`, {})).status).toBe(200);
    expect(TaskResponseSchema.parse(await (await call("GET", `/tasks/${blocked.id}`)).json()).task.blockedBy).toEqual([]);
  });

  it("lists the board's members", async () => {
    const response = await (await call("GET", "/board/members")).json() as { members: unknown[] };
    expect(response.members).toEqual(MEMBERS);
  });

  it("notifies a new assignee and mentioned members, never the person acting", async () => {
    actor = "agent:chat_abc";
    const task = await create("Assigned", { assignee: "user:user_owner" });
    expect(notifications).toEqual([expect.objectContaining({ kind: "assigned", recipient: "user:user_owner", dedupeKey: `task:${task.id}:assigned:agent:chat_abc` })]);
    actor = "user:user_owner";
    await call("PATCH", `/tasks/${task.id}`, { baseRevision: 1, assignee: "user:user_owner" });
    expect(notifications).toHaveLength(1);
    notifications.length = 0;
    actor = "agent:chat_abc";
    await call("POST", `/tasks/${task.id}/comments`, { body: "Done, @ana please review" });
    expect(notifications.map((notification) => [notification.kind, notification.recipient])).toEqual([
      ["mentioned", "user:user_ana"],
      ["commented", "user:user_owner"],
    ]);
  });
});
