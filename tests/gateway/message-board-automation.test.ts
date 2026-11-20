import { Hono } from "hono";
import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardActor } from "@matrix-os/contracts/message-board";
import type { MessageBoardDatabase } from "../../packages/gateway/src/message-board/database.js";
import { MessageBoardServiceError } from "../../packages/gateway/src/message-board/errors.js";
import { createMessageBoardRoutes } from "../../packages/gateway/src/message-board/routes.js";
import { startMessageBoardRuntime, type MessageBoardRuntime } from "../../packages/gateway/src/message-board/runtime.js";
import type { BoardCaller } from "../../packages/gateway/src/message-board/service.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

const owner: BoardCaller = { ownerId: "owner_1", actor: { id: "user:owner_1", kind: "user", name: "hamed" } };
const agentActor: BoardActor = { id: "agent:tws_1.tt_1", kind: "agent", name: "terminal tt_1" };
const agent: BoardCaller = { ownerId: "owner_1", actor: agentActor, can: ["read", "post", "react", "label"] };

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    if (error instanceof MessageBoardServiceError) return error.reason;
    throw error;
  }
}

describe("watchers", () => {
  let db: Kysely<MessageBoardDatabase>;
  let runtime: MessageBoardRuntime;
  let started: Array<Record<string, unknown>>;
  let fail = false;
  const notifications: string[] = [];

  beforeEach(async () => {
    const pglite = await createTestPGlite();
    db = new Kysely<MessageBoardDatabase>({ dialect: pglite.dialect });
    runtime = await startMessageBoardRuntime(db, { timers: false });
    runtime.watchers.start();
    started = [];
    fail = false;
    notifications.length = 0;
    runtime.configureAutomation({
      actions: { start: async (input) => { if (fail) throw new Error("template missing /secret/path"); started.push(input); } },
      notifier: { notify: (notification) => notifications.push(notification.dedupeKey) },
      ownerHandles: ["hamed"],
    });
  });

  afterEach(async () => {
    runtime.close();
    await db.destroy();
  });

  const settle = () => runtime.watchers.idle();

  it("starts one agent per matching post with the message marked by origin, never for its own or deep writes", async () => {
    const watcher = await runtime.watchers.create(owner, undefined, {
      name: "incident-triage", tail: { channel: "incidents/", label: "severity" }, action: { kind: "start", template: "incident-responder", project: "matrix-os" },
    });
    const posted = await runtime.service.post(agent, undefined, { channel: "incidents/api", text: "502s on /api/files", labels: { severity: "sev2" } });
    await runtime.service.post(agent, undefined, { channel: "incidents/api", text: "No label" });
    await runtime.service.post(agent, undefined, { channel: "dev", text: "Wrong channel", labels: { severity: "sev1" } });
    await settle();
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ template: "incident-responder", projectId: "matrix-os", origin: { watcher: "incident-triage", depth: 1 } });
    expect(String(started[0]!.task)).toContain(`<matrix from="board:General/incidents/api#${posted.id}">`);
    // Writes from the session it started carry its name and depth and do not wake it again.
    await runtime.service.post({ ...agent, origin: { watcher: "incident-triage", depth: 1 } }, undefined, { channel: "incidents/api", text: "Looking", re: posted.id, labels: { severity: "sev2" } });
    await runtime.service.post({ ...agent, origin: { watcher: "other", depth: 3 } }, undefined, { channel: "incidents/api", text: "Too deep", labels: { severity: "sev2" } });
    await settle();
    expect(started).toHaveLength(1);
    const [described] = await runtime.watchers.list(owner, undefined);
    expect(described).toMatchObject({ id: watcher.id, totalRuns: 1, runsThisHour: 1, enabled: true });
  });

  it("writes one run per event cursor and retries a failed action with backoff, recording only generic errors", async () => {
    await runtime.watchers.create(owner, undefined, { name: "dev-watch", tail: { channel: "dev" }, action: { kind: "start", template: "fixer" } });
    fail = true;
    await runtime.service.post(agent, undefined, { channel: "dev", text: "Fix it" });
    await settle();
    let [described] = await runtime.watchers.list(owner, undefined);
    expect(described!.lastError).toBe("The last run could not start. Check the watcher's action and try again.");
    expect(described!.lastError).not.toContain("secret");
    expect(await runtime.watchers.retryPending()).toBe(0);
    fail = false;
    await db.updateTable("board_watcher_runs").set({ next_attempt_at: new Date(0) }).execute();
    expect(await runtime.watchers.retryPending()).toBe(1);
    expect(started).toHaveLength(1);
    [described] = await runtime.watchers.list(owner, undefined);
    expect(described!.lastError).toBeNull();
    expect(await runtime.watchers.retryPending()).toBe(0);
  });

  it("records a failed run when the action kind is not available here", async () => {
    await runtime.watchers.create(owner, undefined, { name: "send-watch", tail: { channel: "dev" }, action: { kind: "send", session: "chat_123" } });
    await runtime.service.post(agent, undefined, { channel: "dev", text: "Ping" });
    await settle();
    const runs = await db.selectFrom("board_watcher_runs").selectAll().execute();
    expect(runs).toMatchObject([{ outcome: "failed", attempts: 1 }]);
  });

  it("pauses itself at the hourly cap, posts once in the thread and notifies the owner once", async () => {
    await runtime.watchers.create(owner, undefined, { name: "busy", tail: { channel: "dev" }, action: { kind: "start", template: "fixer" }, maxRunsPerHour: 2 });
    // One at a time: PGlite runs every transaction on a single connection.
    for (let index = 0; index < 4; index += 1) {
      await runtime.service.post(agent, undefined, { channel: "dev", text: `post ${index}` });
      await settle();
    }
    expect(started).toHaveLength(2);
    const [described] = await runtime.watchers.list(owner, undefined);
    expect(described!.enabled).toBe(false);
    const notices = await runtime.service.listMessages(owner, undefined, { by: "watcher:busy" });
    expect(notices).toHaveLength(1);
    expect(notifications.filter((key) => key.startsWith("board:watcher:busy:paused"))).toHaveLength(1);
  });

  it("caps watchers per board and keeps names unique", async () => {
    await runtime.watchers.create(owner, undefined, { name: "w0", tail: { channel: "dev" }, action: { kind: "start", template: "t" } });
    expect(await reason(runtime.watchers.create(owner, undefined, { name: "w0", tail: { channel: "dev" }, action: { kind: "start", template: "t" } }))).toBe("duplicate_id");
    for (let index = 1; index < 32; index += 1) await runtime.watchers.create(owner, undefined, { name: `w${index}`, tail: { channel: "dev" }, action: { kind: "start", template: "t" } });
    expect(await reason(runtime.watchers.create(owner, undefined, { name: "w32", tail: { channel: "dev" }, action: { kind: "start", template: "t" } }))).toBe("limit_reached");
  });

  it("notifies the owner of mentions and of blocked tasks they created, once each", async () => {
    await runtime.service.post(agent, undefined, { channel: "dev", text: "@hamed can you approve?" });
    const task = await runtime.tasks.create(owner, undefined, { channel: "dev", text: "Approve the cleanup" });
    const claim = await runtime.tasks.claim(agent, undefined, { id: task.root.id });
    await runtime.tasks.block(agent, undefined, task.root.id, { epoch: claim.epoch, token: claim.token, reason: "Need a decision", kind: "needs_input" });
    await vi.waitFor(() => expect(notifications.filter((key) => key.includes(":mention:") || key.includes(":blocked:"))).toHaveLength(2));
  });
});

describe("schedules", () => {
  let db: Kysely<MessageBoardDatabase>;
  let runtime: MessageBoardRuntime;

  beforeEach(async () => {
    const pglite = await createTestPGlite();
    db = new Kysely<MessageBoardDatabase>({ dialect: pglite.dialect });
    runtime = await startMessageBoardRuntime(db, { timers: false });
  });

  afterEach(async () => {
    runtime.close();
    await db.destroy();
  });

  it("posts later as its author, repeats, and stops after --times", async () => {
    const root = await runtime.service.post(agent, undefined, { channel: "dev", text: "Fix CI" });
    const schedule = await runtime.schedules.create(agent, undefined, { thread: root.id, text: "Check CI", in: "5m", every: "10m", times: 2 });
    expect(schedule).toMatchObject({ target: { kind: "thread", threadId: root.id, channel: "dev" }, every: "10m", remaining: 2, by: { id: agentActor.id } });
    expect(await runtime.schedules.runDue()).toBe(0);
    await db.updateTable("board_schedules").set({ next_run_at: new Date(0) }).execute();
    expect(await runtime.schedules.runDue()).toBe(1);
    expect((await runtime.service.getThread(owner, undefined, root.id)).replies.map((reply) => [reply.text, reply.by.id])).toEqual([["Check CI", agentActor.id]]);
    expect(await runtime.schedules.list(owner, undefined)).toMatchObject([{ remaining: 1, runCount: 1 }]);
    await db.updateTable("board_schedules").set({ next_run_at: new Date(0) }).execute();
    expect(await runtime.schedules.runDue()).toBe(1);
    expect(await runtime.schedules.list(owner, undefined)).toEqual([]);
  });

  it("validates timing, lets the creator or owner cancel, and serves the routes", async () => {
    const app = new Hono();
    let caller = agent;
    app.route("/api/board", createMessageBoardRoutes({
      service: runtime.service, tasks: runtime.tasks, hub: runtime.hub, resolveCaller: () => caller,
      automation: { watchers: runtime.watchers, schedules: runtime.schedules, grants: runtime.grants },
    }));
    const post = (path: string, body: unknown) => app.request(`/api/board${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("/schedules", { channel: "dev", text: "Too soon", every: "30s" })).status).toBe(400);
    expect((await post("/schedules", { channel: "dev", text: "Both", in: "5m", at: "2030-01-01T00:00:00Z" })).status).toBe(400);
    const created = await (await post("/schedules", { channel: "dev", text: "Weekly summary", in: "1m", every: "7d" })).json() as { schedule: { id: string } };
    expect((await post("/watchers", { name: "x", tail: { channel: "dev" }, action: { kind: "start", template: "t" } })).status).toBe(403);
    const other: BoardCaller = { ownerId: "owner_1", actor: { id: "agent:tws_1.tt_9", kind: "agent", name: "other" }, can: ["read", "post"] };
    caller = other;
    expect((await app.request(`/api/board/schedules/${created.schedule.id}`, { method: "DELETE" })).status).toBe(403);
    caller = owner;
    expect((await app.request(`/api/board/schedules/${created.schedule.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request("/api/board/schedules")).status).toBe(200);
  });
});
