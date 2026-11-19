import { Hono } from "hono";
import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardActor, BoardEvent, BoardSocketFrame } from "@matrix-os/contracts/message-board";
import { bootstrapMessageBoardDatabase, type MessageBoardDatabase } from "../../packages/gateway/src/message-board/database.js";
import { BoardEventHub, readBoardEvents } from "../../packages/gateway/src/message-board/events.js";
import { registerBoardEventsWebSocket } from "../../packages/gateway/src/message-board/events-ws.js";
import { createMessageBoardRoutes } from "../../packages/gateway/src/message-board/routes.js";
import { BoardTaskService } from "../../packages/gateway/src/message-board/tasks.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

const OWNER = "owner_1";
const owner: BoardActor = { id: "user:owner_1", kind: "user", name: "Owner" };
const agent: BoardActor = { id: "agent:chat_1", kind: "agent", name: "chat_1", profile: "fixer" };
const as = (actor: BoardActor) => ({ ownerId: OWNER, actor });

function event(cursor: number, overrides: Partial<BoardEvent> = {}): BoardEvent {
  return { cursor: String(cursor), type: "message.posted", board: "General", createdAt: "2026-11-20T10:00:00.000Z", actor: owner, channel: "dev", ...overrides };
}

describe("BoardEventHub", () => {
  function subscriber(overrides: Record<string, unknown> = {}) {
    const frames: BoardSocketFrame[] = [];
    const close = vi.fn();
    return { frames, close, spec: { ownerId: OWNER, boardName: "General", actorId: owner.id, send: (frame: BoardSocketFrame) => frames.push(frame), close, ...overrides } };
  }

  it("delivers only matching board and channel events, after replay, in order without duplicates", () => {
    const hub = new BoardEventHub({ heartbeatMs: 0 });
    const a = subscriber({ channel: "security/" });
    const handle = hub.subscribe(a.spec);
    hub.publish(OWNER, [event(3, { channel: "security/findings" })]);
    expect(a.frames).toEqual([]);
    handle.live("2");
    hub.publish(OWNER, [event(3, { channel: "security/findings" }), event(4, { channel: "dev" }), event(5, { channel: "security" })]);
    hub.publish("other_owner", [event(6, { channel: "security" })]);
    expect(a.frames.map((frame) => frame.type === "event" ? frame.event.cursor : frame.type)).toEqual(["3", "5"]);
  });

  it("caps subscribers per actor, per board and per gateway", () => {
    const hub = new BoardEventHub({ heartbeatMs: 0, maxPerActor: 2, maxPerBoard: 3, maxSubscribers: 4 });
    hub.subscribe(subscriber().spec);
    hub.subscribe(subscriber().spec);
    expect(() => hub.subscribe(subscriber().spec)).toThrow("unavailable");
    hub.subscribe(subscriber({ actorId: agent.id }).spec);
    expect(() => hub.subscribe(subscriber({ actorId: "agent:x" }).spec)).toThrow("unavailable");
    hub.subscribe(subscriber({ actorId: "agent:y", boardName: "Ops" }).spec);
    expect(() => hub.subscribe(subscriber({ actorId: "agent:z", boardName: "Ops2" }).spec)).toThrow("unavailable");
  });

  it("evicts silent subscribers, failed senders and those too far behind", () => {
    let now = 0;
    const hub = new BoardEventHub({ heartbeatMs: 0, now: () => now, staleMs: 60_000 });
    const quiet = subscriber();
    hub.subscribe(quiet.spec).live("0");
    const pinging = subscriber({ actorId: "agent:a" });
    const pingHandle = hub.subscribe(pinging.spec);
    pingHandle.live("0");
    now = 59_000;
    pingHandle.touch();
    now = 61_000;
    hub.tick();
    expect(quiet.close).toHaveBeenCalled();
    expect(hub.size()).toBe(1);
    const broken = subscriber({ actorId: "agent:b", send: () => { throw new Error("socket gone"); } });
    hub.subscribe(broken.spec).live("0");
    const slow = subscriber({ actorId: "agent:c", backlog: () => 2 * 1024 * 1024 });
    hub.subscribe(slow.spec).live("0");
    hub.publish(OWNER, [event(1)]);
    expect(broken.close).toHaveBeenCalled();
    expect(slow.frames).toEqual([{ type: "missed", cursor: "0" }]);
    expect(slow.close).toHaveBeenCalled();
    expect(pinging.frames.at(-1)).toMatchObject({ type: "event" });
    expect(hub.size()).toBe(1);
  });

  it("drains subscribers and releases long-poll waiters on shutdown", async () => {
    const hub = new BoardEventHub({ heartbeatMs: 0 });
    const live = subscriber();
    hub.subscribe(live.spec).live("0");
    const waiting = hub.waitForEvents(OWNER, "General", 60_000);
    expect(hub.waiting()).toBe(1);
    hub.shutdown();
    await waiting;
    expect(live.frames).toEqual([{ type: "shutdown" }]);
    expect(live.close).toHaveBeenCalled();
    expect(hub.size()).toBe(0);
    expect(() => hub.subscribe(subscriber().spec)).toThrow("unavailable");
  });

  it("bounds long-poll waiters", () => {
    const hub = new BoardEventHub({ heartbeatMs: 0, maxWaiters: 1 });
    void hub.waitForEvents(OWNER, "General", 10);
    expect(() => hub.waitForEvents(OWNER, "General", 10)).toThrow("unavailable");
  });
});

describe("board event log, long-poll and socket", () => {
  let db: Kysely<MessageBoardDatabase>;
  let tasks: BoardTaskService;
  let hub: BoardEventHub;
  let app: Hono;
  let clock: number;

  beforeEach(async () => {
    const pglite = await createTestPGlite();
    db = new Kysely<MessageBoardDatabase>({ dialect: pglite.dialect });
    await bootstrapMessageBoardDatabase(db);
    clock = Date.parse("2026-11-20T10:00:00.000Z");
    hub = new BoardEventHub({ heartbeatMs: 0 });
    tasks = BoardTaskService.attach(db, { now: () => new Date(clock), onEvents: (o, e) => hub.publish(o, e), limits: { writesPerMinute: 10_000 } });
    app = new Hono();
    app.route("/api/board", createMessageBoardRoutes({ service: tasks.board, tasks, hub, resolveCaller: () => as(owner) }));
  });

  afterEach(async () => {
    hub.shutdown();
    await db.destroy();
  });

  it("pages the log by cursor with channel and thread filters, never skipping", async () => {
    const root = await tasks.board.post(as(owner), undefined, { channel: "dev", text: "Root" });
    await tasks.board.post(as(owner), undefined, { channel: "ops", text: "Other" });
    await tasks.board.post(as(agent), undefined, { channel: "dev", text: "Reply", re: root.id });
    const board = await tasks.board.resolveBoard(OWNER, undefined);
    const all = await readBoardEvents(db, board, { after: "0", limit: 100 });
    expect(all.events.map((item) => item.cursor)).toEqual(["1", "2", "3", "4", "5"]);
    const dev = await readBoardEvents(db, board, { after: "0", limit: 100, channel: "dev" });
    expect(dev.events.map((item) => item.type)).toEqual(["channel.created", "message.posted", "message.posted"]);
    expect(dev.cursor).toBe("5");
    const thread = await readBoardEvents(db, board, { after: "0", limit: 2, thread: root.id });
    expect(thread).toEqual({ events: [expect.objectContaining({ cursor: "2" })], cursor: "2" });
    expect(await readBoardEvents(db, board, { limit: 10 })).toEqual({ events: [], cursor: "5" });
  });

  it("reports missed when the cursor is older than the retained window", async () => {
    await tasks.board.post(as(owner), undefined, { channel: "dev", text: "Old" });
    clock += 31 * 24 * 60 * 60_000;
    await tasks.board.post(as(owner), undefined, { channel: "dev", text: "New" });
    expect(await tasks.pruneEvents()).toBe(2);
    const board = await tasks.board.resolveBoard(OWNER, undefined);
    const page = await readBoardEvents(db, board, { after: "0", limit: 10 });
    expect(page).toMatchObject({ missed: true, cursor: "3" });
    expect(page.events.map((item) => item.cursor)).toEqual(["3"]);
  });

  it("delivers 100 posts in order to a client looping on long-poll", async () => {
    const seen: string[] = [];
    let cursor = "0";
    const writer = (async () => {
      for (let index = 0; index < 100; index += 1) await tasks.board.post(as(agent), undefined, { channel: "dev", text: `m${index}` });
    })();
    while (seen.length < 101) {
      const response = await app.request(`/api/board/events?after=${cursor}&wait=2&limit=7`);
      const page = await response.json() as { events: BoardEvent[]; cursor: string };
      seen.push(...page.events.map((item) => item.cursor));
      cursor = page.cursor;
    }
    await writer;
    expect(seen).toEqual(Array.from({ length: 101 }, (_, index) => String(index + 1)));
  });

  it("holds a long-poll open until the next event", async () => {
    const pending = app.request("/api/board/events?wait=5");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await tasks.board.post(as(owner), undefined, { channel: "dev", text: "Wake" });
    const page = await (await pending).json() as { events: BoardEvent[] };
    expect(page.events.map((item) => item.type)).toEqual(["channel.created", "message.posted"]);
    expect((await app.request("/api/board/events?wait=99")).status).toBe(400);
  });

  it("replays from a cursor over the socket, then streams live, and answers pings", async () => {
    await tasks.board.post(as(owner), undefined, { channel: "dev", text: "Before" });
    const handlers: Record<string, (...args: unknown[]) => unknown> = {};
    const socketApp = new Hono();
    registerBoardEventsWebSocket({
      app: socketApp, hub, service: tasks.board, resolveCaller: () => as(owner),
      upgradeWebSocket: ((factory: (c: unknown) => Record<string, (...args: unknown[]) => unknown>) => async (c: unknown) => {
        Object.assign(handlers, factory(c));
        return new Response(null);
      }) as never,
    });
    await socketApp.request("/ws/board/events?after=1");
    const sent: BoardSocketFrame[] = [];
    const ws = { send: (data: string) => sent.push(JSON.parse(data)), close: vi.fn(), raw: { bufferedAmount: 0 } };
    await handlers.onOpen!({}, ws);
    expect(sent.map((frame) => frame.type === "event" ? frame.event.cursor : frame.type)).toEqual(["2", "ready"]);
    await tasks.board.post(as(owner), undefined, { channel: "dev", text: "Live" });
    expect(sent.at(-1)).toMatchObject({ type: "event", event: { cursor: "3", type: "message.posted" } });
    handlers.onMessage!({ data: JSON.stringify({ type: "ping" }) }, ws);
    expect(sent.at(-1)).toEqual({ type: "pong" });
    handlers.onMessage!({ data: JSON.stringify({ type: "subscribe", channel: "*" }) }, ws);
    expect(ws.close).toHaveBeenCalledWith(1003, "Invalid message");
    handlers.onClose!();
    expect(hub.size()).toBe(0);
  });
});
