import { Hono } from "hono";
import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardActor } from "@matrix-os/contracts/message-board";
import { bootstrapMessageBoardDatabase, type MessageBoardDatabase } from "../../packages/gateway/src/message-board/database.js";
import { createMessageBoardRoutes, MESSAGE_BOARD_BODY_LIMIT } from "../../packages/gateway/src/message-board/routes.js";
import { MessageBoardService } from "../../packages/gateway/src/message-board/service.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { registerMessageBoardGatewayRoutes } from "../../packages/gateway/src/server/message-board-gateway-routes.js";

const owner: BoardActor = { id: "user:owner_1", kind: "user", name: "Owner" };
const agent: BoardActor = { id: "agent:chat_abc", kind: "agent", name: "chat_abc" };

describe("/api/board routes", () => {
  let db: Kysely<MessageBoardDatabase>;
  let app: Hono;
  let caller: BoardActor;

  beforeEach(async () => {
    const pglite = await createTestPGlite();
    db = new Kysely<MessageBoardDatabase>({ dialect: pglite.dialect });
    await bootstrapMessageBoardDatabase(db);
    caller = owner;
    const service = new MessageBoardService(db);
    app = new Hono();
    app.route("/api/board", createMessageBoardRoutes({ service, resolveCaller: () => ({ ownerId: "owner_1", actor: caller }) }));
  });

  afterEach(async () => db.destroy());

  const send = (method: string, path: string, body?: unknown) => app.request(`/api/board${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

  it("posts, replies and reads a thread through the routes", async () => {
    const posted = await send("POST", "/messages", { channel: "dev", text: "Login test is flaky", labels: { kind: "bug" } });
    expect(posted.status).toBe(201);
    const { message } = await posted.json() as { message: { id: string } };
    caller = agent;
    const reply = await send("POST", "/messages", { channel: "dev", text: "On it", re: message.id, profile: "fixer" });
    expect(((await reply.json()) as { message: { by: BoardActor } }).message.by).toMatchObject({ id: agent.id, profile: "fixer" });
    caller = owner;
    const thread = await (await send("GET", `/threads/${message.id}`)).json() as { thread: { replies: unknown[] } };
    expect(thread.thread.replies).toHaveLength(1);
    const listed = await (await send("GET", "/threads?channel=dev&label=kind%3Dbug")).json() as { threads: Array<{ unread: boolean }> };
    expect(listed.threads).toHaveLength(1);
    expect(listed.threads[0]!.unread).toBe(true);
    expect((await send("POST", `/threads/${message.id}/read`)).status).toBe(200);
    const channels = await (await send("GET", "/channels")).json() as { channels: Array<{ path: string; unread: number }> };
    expect(channels.channels).toEqual([expect.objectContaining({ path: "dev", unread: 0 })]);
  });

  it("validates input at the boundary and returns stable reasons without internals", async () => {
    const bad = await send("POST", "/messages", { channel: "Dev Ops", text: "x" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Invalid request.", reason: "invalid_input" });
    expect((await send("POST", "/messages", "{not json")).status).toBe(400);
    expect((await send("GET", "/threads/not-an-id")).status).toBe(400);
    expect((await send("GET", "/threads?limit=501")).status).toBe(400);
    expect((await send("GET", "/threads?channel=a//b")).status).toBe(400);
    const reserved = await send("POST", "/messages", { channel: "dev", text: "x", labels: { "board.task": "ready" } });
    expect(await reserved.json()).toMatchObject({ reason: "reserved_label" });
    const missing = await send("GET", "/threads/msg_doesnotexist01");
    expect(missing.status).toBe(404);
    expect((await send("GET", "/channels?board=Nope")).status).toBe(404);
  });

  it("limits request bodies on every mutating route, including DELETE", async () => {
    const huge = JSON.stringify({ channel: "dev", text: "x".repeat(MESSAGE_BOARD_BODY_LIMIT) });
    expect((await send("POST", "/messages", huge)).status).toBe(413);
    const { message } = await (await send("POST", "/messages", { channel: "dev", text: "Mine" })).json() as { message: { id: string } };
    expect((await send("DELETE", `/messages/${message.id}`, JSON.stringify({ pad: "x".repeat(MESSAGE_BOARD_BODY_LIMIT) }))).status).toBe(413);
    expect((await send("DELETE", `/messages/${message.id}`)).status).toBe(200);
    expect((await send("DELETE", `/messages/${message.id}`)).status).toBe(410);
  });

  it("edits with revisions, reacts, labels, and lets only people create boards", async () => {
    const { message } = await (await send("POST", "/messages", { channel: "dev", text: "Draft" })).json() as { message: { id: string } };
    expect((await send("PATCH", `/messages/${message.id}`, { text: "Final", ifRevision: 1 })).status).toBe(200);
    expect((await send("PATCH", `/messages/${message.id}`, { text: "Stale", ifRevision: 1 })).status).toBe(409);
    expect((await send("POST", `/messages/${message.id}/reactions`, { emoji: "👀", on: true })).status).toBe(200);
    expect((await send("PATCH", `/messages/${message.id}/labels`, { set: { pr: "#1" }, ifUnset: ["pr"] })).status).toBe(200);
    expect((await send("PATCH", `/messages/${message.id}/labels`, { set: { pr: "#2" }, ifUnset: ["pr"] })).status).toBe(409);
    const messages = await (await send("GET", "/messages?label=pr")).json() as { messages: Array<{ reactions: unknown[] }> };
    expect(messages.messages[0]!.reactions).toEqual([{ emoji: "👀", actors: [owner.id] }]);
    caller = agent;
    expect((await send("POST", "/boards", { name: "Ops" })).status).toBe(403);
    caller = owner;
    expect((await send("POST", "/boards", { name: "Ops" })).status).toBe(201);
    const boards = await (await send("GET", "/boards")).json() as { boards: Array<{ name: string }> };
    expect(boards.boards.map((item) => item.name)).toEqual(["General", "Ops"]);
    expect((await send("POST", "/channels?board=Ops", { path: "infra/alerts" })).status).toBe(201);
    expect((await send("POST", "/channels?board=Ops", { path: "infra/alerts" })).status).toBe(409);
  });

  it("answers 503 with a generic reason when the owner database is missing", async () => {
    const bare = new Hono();
    registerMessageBoardGatewayRoutes({ app: bare, service: null });
    const response = await bare.request("/api/board/threads");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "The message board is unavailable.", reason: "unavailable" });
  });
});
