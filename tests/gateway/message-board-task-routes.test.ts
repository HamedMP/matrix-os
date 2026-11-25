import { Hono } from "hono";
import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardActor } from "@matrix-os/contracts/message-board";
import { bootstrapMessageBoardDatabase, type MessageBoardDatabase } from "../../packages/gateway/src/message-board/database.js";
import { createMessageBoardRoutes } from "../../packages/gateway/src/message-board/routes.js";
import { BoardTaskService } from "../../packages/gateway/src/message-board/tasks.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

const owner: BoardActor = { id: "user:owner_1", kind: "user", name: "Owner" };
const agent: BoardActor = { id: "agent:chat_1", kind: "agent", name: "chat_1" };

describe("/api/board/tasks routes", () => {
  let db: Kysely<MessageBoardDatabase>;
  let app: Hono;
  let caller: BoardActor;

  beforeEach(async () => {
    const pglite = await createTestPGlite();
    db = new Kysely<MessageBoardDatabase>({ dialect: pglite.dialect });
    await bootstrapMessageBoardDatabase(db);
    caller = owner;
    const tasks = BoardTaskService.attach(db);
    app = new Hono();
    app.route("/api/board", createMessageBoardRoutes({ service: tasks.board, tasks, resolveCaller: () => ({ ownerId: "owner_1", actor: caller }) }));
  });

  afterEach(async () => db.destroy());

  const post = async (path: string, body: unknown) => app.request(`/api/board${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

  it("creates, claims with a token, and completes a task over HTTP", async () => {
    const created = await post("/tasks", { channel: "dev", text: "Fix flaky login test", labels: { kind: "bug" } });
    expect(created.status).toBe(201);
    const { root } = await created.json() as { root: { id: string } };
    caller = agent;
    const claimResponse = await post("/tasks/claim", { ready: "dev", profile: "fixer" });
    const { claim } = await claimResponse.json() as { claim: { taskId: string; epoch: number; token: string; task: { holder: BoardActor } } };
    expect(claim).toMatchObject({ taskId: root.id, epoch: 1, task: { holder: { id: agent.id, profile: "fixer" } } });
    expect(claim.token).toMatch(/^[a-f0-9]{64}$/);
    expect((await (await post("/tasks/claim", { id: root.id })).json())).toMatchObject({ reason: "task_claimed" });
    expect((await post(`/tasks/${root.id}/renew`, { epoch: 1, token: claim.token })).status).toBe(200);
    expect((await post(`/tasks/${root.id}/complete`, { epoch: 1, token: "f".repeat(64) })).status).toBe(409);
    expect((await post(`/tasks/${root.id}/complete`, { epoch: 1, token: claim.token, result: "Merged #3501" })).status).toBe(200);
    caller = owner;
    const listed = await (await app.request("/api/board/tasks?state=completed")).json() as { tasks: Array<{ task: { result: string } }> };
    expect(listed.tasks.map((item) => item.task.result)).toEqual(["Merged #3501"]);
    expect((await (await app.request("/api/board/tasks")).json() as { tasks: unknown[] }).tasks).toHaveLength(1);
  });

  it("creates a plan, turns a thread into a task, and validates bodies", async () => {
    const plan = await post("/tasks", { channel: "dev", tasks: [{ key: "a", text: "A" }, { key: "b", text: "B", needs: ["a"] }] });
    expect(plan.status).toBe(201);
    const { tasks } = await plan.json() as { tasks: Array<{ task: { state: string } }> };
    expect(tasks.map((item) => item.task.state)).toEqual(["ready", "waiting"]);
    const message = await (await post("/messages", { channel: "dev", text: "Idea" })).json() as { message: { id: string } };
    expect((await post("/tasks", { rootId: message.message.id })).status).toBe(201);
    expect((await post("/tasks", { rootId: message.message.id })).status).toBe(409);
    expect((await post("/tasks/claim", { ready: "dev", leaseSeconds: 99999 })).status).toBe(400);
    expect((await post(`/tasks/${message.message.id}/block`, { reason: "" })).status).toBe(400);
    expect((await post("/tasks", { channel: "dev", tasks: Array.from({ length: 16 }, (_, index) => ({ key: `k${index}`, text: "x" })) })).status).toBe(400);
    const big = await post("/tasks", { channel: "dev", tasks: Array.from({ length: 15 }, (_, index) => ({ key: `b${index}`, text: "y".repeat(10_000) })) });
    expect(big.status).toBe(201);
    expect((await post(`/tasks/${message.message.id}/cancel`, { reason: "Dropped" })).status).toBe(200);
    expect((await post(`/tasks/${message.message.id}/reopen`, {})).status).toBe(200);
  });
});
