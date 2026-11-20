import { Hono } from "hono";
import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardActor } from "@matrix-os/contracts/message-board";
import type { MessageBoardDatabase } from "../../packages/gateway/src/message-board/database.js";
import { MessageBoardServiceError } from "../../packages/gateway/src/message-board/errors.js";
import { createMessageBoardRoutes } from "../../packages/gateway/src/message-board/routes.js";
import { startMessageBoardRuntime, type MessageBoardRuntime } from "../../packages/gateway/src/message-board/runtime.js";
import type { BoardCaller } from "../../packages/gateway/src/message-board/service.js";
import { MAX_WATCHER_ATTEMPTS } from "../../packages/gateway/src/message-board/watchers.js";
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

  it("counts every failed attempt in the database and gives up at the limit", async () => {
    await runtime.watchers.create(owner, undefined, { name: "flaky", tail: { channel: "dev" }, action: { kind: "start", template: "fixer" } });
    fail = true;
    await runtime.service.post(agent, undefined, { channel: "dev", text: "Keep failing" });
    await settle();
    for (let round = 0; round < 10; round += 1) {
      await db.updateTable("board_watcher_runs").set({ next_attempt_at: new Date(0) }).execute();
      await runtime.watchers.retryPending();
    }
    const [run] = await db.selectFrom("board_watcher_runs").select(["attempts", "outcome", "next_attempt_at"]).execute();
    expect(run!.outcome).toBe("failed");
    expect(run!.attempts).toBe(MAX_WATCHER_ATTEMPTS);
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

describe("watcher durability and schedule edges", () => {
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

  it("matches posts the in-memory queue missed by replaying the event log from saved progress", async () => {
    const started: unknown[] = [];
    runtime.configureAutomation({ actions: { start: async (input) => { started.push(input); } } });
    await runtime.watchers.create(owner, undefined, { name: "dev-watch", tail: { channel: "dev" }, action: { kind: "start", template: "fixer" } });
    await runtime.watchers.sweep(); // first pass records where matching starts
    // The dispatcher is down (restart, full queue): the post is committed but never matched live.
    await runtime.service.post(agent, undefined, { channel: "dev", text: "Missed live" });
    expect(started).toHaveLength(0);
    runtime.watchers.start();
    await vi.waitFor(() => expect(started).toHaveLength(1));
    await runtime.watchers.sweep();
    expect(started).toHaveLength(1);
  });

  it("records an undelivered task as a final failure instead of retrying into a skipped launch", async () => {
    runtime.configureAutomation({ actions: { start: async () => ({ delivered: false }) } });
    runtime.watchers.start();
    await runtime.watchers.create(owner, undefined, { name: "dev-watch", tail: { channel: "dev" }, action: { kind: "start", template: "fixer" } });
    await runtime.service.post(agent, undefined, { channel: "dev", text: "Go" });
    await runtime.watchers.idle();
    expect(await db.selectFrom("board_watcher_runs").select(["outcome", "last_error"]).execute())
      .toEqual([{ outcome: "failed", last_error: "The agent started but did not get its task. Open it from Terminal to continue." }]);
  });

  it("never pauses a watcher for a post it already admitted when live matching and replay race", async () => {
    const started: unknown[] = [];
    runtime.configureAutomation({ actions: { start: async (input) => { started.push(input); } } });
    await runtime.watchers.create(owner, undefined, { name: "one-per-hour", tail: { channel: "dev" }, action: { kind: "start", template: "fixer" }, maxRunsPerHour: 1 });
    await db.insertInto("board_watcher_progress").values({ owner_id: "owner_1", board_id: (await runtime.service.resolveBoard("owner_1", undefined)).id, cursor: "0", updated_at: new Date() }).execute();
    runtime.watchers.start();
    await runtime.service.post(agent, undefined, { channel: "dev", text: "Only post" });
    await runtime.watchers.idle();
    await db.updateTable("board_watcher_progress").set({ cursor: "0" }).execute();
    await runtime.watchers.sweep(); // replays the same post
    expect(started).toHaveLength(1);
    expect((await runtime.watchers.list(owner, undefined))[0]!.enabled).toBe(true);
  });

  it("keeps runs pending until the gateway supplies its actions, then starts them", async () => {
    runtime.watchers.start();
    await runtime.watchers.create(owner, undefined, { name: "early", tail: { channel: "dev" }, action: { kind: "start", template: "fixer" } });
    await runtime.service.post(agent, undefined, { channel: "dev", text: "Before actions" });
    await runtime.watchers.idle();
    expect(await db.selectFrom("board_watcher_runs").select("outcome").execute()).toEqual([{ outcome: null }]);
    const started: unknown[] = [];
    await db.updateTable("board_watcher_runs").set({ next_attempt_at: new Date(0) }).execute();
    runtime.configureAutomation({ actions: { start: async (input) => { started.push(input); } } });
    await vi.waitFor(() => expect(started).toHaveLength(1));
  });

  it("cuts a long post to what a terminal launch accepts and points at the whole message", async () => {
    const { watcherTaskText } = await import("../../packages/gateway/src/message-board/watchers.js");
    const text = watcherTaskText({ board: "General", channel: "dev", messageId: "msg_abcdefgh1234" }, "x".repeat(9_000));
    expect(text.length).toBeLessThan(8_192);
    expect(text).toContain("matrix board read msg_abcdefgh1234");
  });

  it("keeps a watcher session's provenance on its scheduled posts", async () => {
    const fromWatcher: BoardCaller = { ...agent, origin: { watcher: "triage", depth: 1 } };
    const root = await runtime.service.post(owner, undefined, { channel: "dev", text: "Root" });
    await runtime.schedules.create(fromWatcher, undefined, { thread: root.id, text: "Follow up", in: "1m" });
    await db.updateTable("board_schedules").set({ next_run_at: new Date(0) }).execute();
    await runtime.schedules.runDue();
    const [reply] = (await runtime.service.getThread(owner, undefined, root.id)).replies;
    const labels = await db.selectFrom("board_labels").select(["key", "value"]).where("message_id", "=", reply!.id).execute();
    expect(Object.fromEntries(labels.map((row) => [row.key, row.value]))).toEqual({ "matrix.watcher": "triage", "matrix.depth": "1" });
  });

  it("skips missed repetitions and ends a schedule past its stop time without posting", async () => {
    const hourly = await runtime.schedules.create(agent, undefined, { channel: "dev", text: "Hourly", in: "1m", every: "1h" });
    await db.updateTable("board_schedules").set({ next_run_at: new Date(Date.now() - 5 * 3_600_000) }).where("id", "=", hourly.id).execute();
    expect(await runtime.schedules.runDue()).toBe(1);
    const [rescheduled] = await runtime.schedules.list(owner, undefined);
    expect(Date.parse(rescheduled!.nextRunAt)).toBeGreaterThan(Date.now());
    expect(await runtime.schedules.runDue()).toBe(0);
    await runtime.schedules.cancel(owner, undefined, hourly.id);
    const ended = await runtime.schedules.create(agent, undefined, { channel: "dev", text: "Too late", in: "1m", every: "1m", until: new Date(Date.now() + 120_000).toISOString() });
    await db.updateTable("board_schedules").set({ next_run_at: new Date(0), until_at: new Date(Date.now() - 1_000) }).where("id", "=", ended.id).execute();
    expect(await runtime.schedules.runDue()).toBe(0);
    expect(await runtime.schedules.list(owner, undefined)).toEqual([]);
    expect((await runtime.service.listMessages(owner, undefined, { text: "Too late" }))).toEqual([]);
  });

  it("applies the grant cap to private channels too", async () => {
    for (let batch = 0; batch < 15; batch += 1) {
      await runtime.grants.create(owner, undefined, { principals: Array.from({ length: 32 }, (_, index) => `user:u${batch}_${index}`), channel: "*", permissions: ["read"] });
    }
    await runtime.grants.create(owner, undefined, { principals: Array.from({ length: 19 }, (_, index) => `user:x${index}`), channel: "*", permissions: ["read"] });
    expect(await reason(runtime.service.createChannel(owner, undefined, "secret", async (ctx) => {
      await runtime.grants.writeGrants(ctx.trx, ctx.board.id, owner, [owner.actor.id], "secret", ["read"], ctx.now);
      await runtime.grants.writeGrants(ctx.trx, ctx.board.id, owner, ["*"], "secret", [], ctx.now);
    }))).toBe("limit_reached");
    expect((await runtime.service.listChannels(owner, undefined)).map((channel) => channel.path)).not.toContain("secret");
  });
});

describe("watcher start adapter", () => {
  it("does not start a second terminal when a retried run's tab already exists", async () => {
    const { configureMessageBoardAutomation } = await import("../../packages/gateway/src/server/message-board-gateway-routes.js");
    let actions: { start?: (input: never) => Promise<void> } = {};
    const runtime = { configureAutomation: (next: { actions?: typeof actions }) => { actions = next.actions ?? {}; } } as unknown as MessageBoardRuntime;
    const run = vi.fn(async () => ({ firstMessage: { sent: true } }));
    const tabs: Array<{ name: string }> = [];
    configureMessageBoardAutomation(runtime, { runTerminalAgent: run, listTerminals: async () => [{ tabs }] });
    const input = { template: "fixer", name: "board-dev", task: "x", idempotencyKey: "wat_1:42", origin: { watcher: "dev", depth: 1 } };
    expect(await actions.start!(input as never)).toEqual({ delivered: true });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ name: "board-dev wat_1:42", labels: { "board.watcher": "dev", "board.depth": "1" } }));
    tabs.push({ name: "board-dev wat_1:42" });
    await actions.start!(input as never);
    expect(run).toHaveBeenCalledTimes(1);
    // The same display name and cursor on another board's watcher is a different run.
    await actions.start!({ ...input, idempotencyKey: "wat_2:42" } as never);
    expect(run).toHaveBeenCalledTimes(2);
    run.mockResolvedValueOnce({ firstMessage: { sent: false } } as never);
    expect(await actions.start!({ ...input, idempotencyKey: "wat_3:7" } as never)).toEqual({ delivered: false });
  });
});
