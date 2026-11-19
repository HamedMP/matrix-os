import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardActor, BoardEvent } from "@matrix-os/contracts/message-board";
import { bootstrapMessageBoardDatabase, type MessageBoardDatabase } from "../../packages/gateway/src/message-board/database.js";
import { MessageBoardServiceError } from "../../packages/gateway/src/message-board/errors.js";
import { MessageBoardService } from "../../packages/gateway/src/message-board/service.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

const OWNER = "owner_1";
const owner: BoardActor = { id: "user:owner_1", kind: "user", name: "Owner" };
const agent: BoardActor = { id: "agent:chat_abc", kind: "agent", name: "chat_abc", profile: "fixer" };

async function reason(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    if (error instanceof MessageBoardServiceError) return error.reason;
    throw error;
  }
}

describe("MessageBoardService", () => {
  let pglite: Awaited<ReturnType<typeof createTestPGlite>>;
  let db: Kysely<MessageBoardDatabase>;
  let service: MessageBoardService;
  let clock: number;
  let events: BoardEvent[];

  beforeEach(async () => {
    pglite = await createTestPGlite();
    db = new Kysely<MessageBoardDatabase>({ dialect: pglite.dialect });
    await bootstrapMessageBoardDatabase(db);
    clock = Date.parse("2026-11-20T10:00:00.000Z");
    events = [];
    service = new MessageBoardService(db, {
      now: () => new Date(clock),
      onEvents: (_owner, batch) => { events.push(...batch); },
      limits: { repliesPerThread: 3, writesPerMinute: 1000 },
    });
  });

  afterEach(async () => {
    await db.destroy();
  });

  const as = (actor: BoardActor) => ({ ownerId: OWNER, actor });
  const tick = (minutes = 1) => { clock += minutes * 60_000; };

  it("bootstraps idempotently and creates the default General board on first use", async () => {
    await expect(bootstrapMessageBoardDatabase(db)).resolves.toBe(1);
    expect(await service.listBoards(OWNER)).toEqual([expect.objectContaining({ name: "General", scope: "personal" })]);
    await service.createBoard(OWNER, "Ops");
    expect(await reason(service.createBoard(OWNER, "ops"))).toBe("duplicate_id");
    expect((await service.listBoards(OWNER)).map((board) => board.name)).toEqual(["General", "Ops"]);
    expect(await reason(service.listChannels(as(owner), "Missing"))).toBe("not_found");
  });

  it("creates a channel on first post and writes ordered events after commit", async () => {
    const root = await service.post(as(owner), undefined, { channel: "security/findings", text: "Token in a log line" });
    expect(root).toMatchObject({ channel: "security/findings", re: null, by: owner, revision: 1 });
    expect(root.id).toMatch(/^msg_/);
    await service.post(as(owner), undefined, { channel: "security/findings", text: "Second" });
    expect(events.map((event) => event.type)).toEqual(["channel.created", "message.posted", "message.posted"]);
    expect(events.map((event) => Number(event.cursor))).toEqual([1, 2, 3]);
    expect(events[1]).toMatchObject({ board: "General", channel: "security/findings", messageId: root.id, threadId: root.id });
    expect((await service.listChannels(as(owner))).map((channel) => channel.path)).toEqual(["security/findings"]);
  });

  it("returns the original message for a retried post with the same idempotency key", async () => {
    const first = await service.post(as(agent), undefined, { channel: "dev", text: "Hi", idempotencyKey: "k1" });
    const count = events.length;
    const retry = await service.post(as(agent), undefined, { channel: "dev", text: "Hi", idempotencyKey: "k1" });
    expect(retry.id).toBe(first.id);
    expect(events).toHaveLength(count);
  });

  it("refuses reserved labels and replies to a missing or deleted root", async () => {
    expect(await reason(service.post(as(owner), undefined, { channel: "dev", text: "x", labels: { "board.task": "ready" } }))).toBe("reserved_label");
    expect(await reason(service.post(as(owner), undefined, { channel: "dev", text: "x", re: "msg_missing0001" }))).toBe("not_found");
  });

  it("threads replies one level deep, counts them, and closes a full thread", async () => {
    const root = await service.post(as(owner), undefined, { channel: "dev", text: "Root" });
    tick();
    const reply = await service.post(as(agent), undefined, { channel: "dev", text: "First", re: root.id });
    // A reply to a reply still belongs to the root, with replyTo kept.
    const nested = await service.post(as(owner), undefined, { channel: "dev", text: "Nested", re: reply.id });
    expect(nested).toMatchObject({ re: root.id, replyTo: reply.id });
    await service.post(as(owner), undefined, { channel: "dev", text: "Third", re: root.id });
    expect(await reason(service.post(as(owner), undefined, { channel: "dev", text: "Fourth", re: root.id }))).toBe("thread_full");
    const thread = await service.getThread(as(owner), undefined, root.id);
    expect(thread.replies.map((item) => item.text)).toEqual(["First", "Nested", "Third"]);
    const [summary] = await service.listThreads(as(owner), undefined, { channel: "dev", limit: 50 });
    expect(summary).toMatchObject({ replyCount: 3, latestReply: expect.objectContaining({ text: "Third" }) });
    expect(await reason(service.post(as(owner), undefined, { channel: "ops", text: "x", re: root.id }))).toBe("invalid_input");
  });

  it("lets only the author edit or delete, enforces revisions, and keeps a tombstone", async () => {
    const root = await service.post(as(agent), undefined, { channel: "dev", text: "Draft" });
    expect(await reason(service.edit(as(owner), undefined, root.id, { text: "Hijack" }))).toBe("forbidden");
    const edited = await service.edit(as(agent), undefined, root.id, { text: "Final", ifRevision: 1 });
    expect(edited).toMatchObject({ text: "Final", revision: 2 });
    expect(await reason(service.edit(as(agent), undefined, root.id, { text: "Stale", ifRevision: 1 }))).toBe("revision_conflict");
    await service.post(as(owner), undefined, { channel: "dev", text: "Reply", re: root.id });
    await service.remove(as(agent), undefined, root.id, {});
    const thread = await service.getThread(as(owner), undefined, root.id);
    expect(thread.root).toMatchObject({ text: "", deletedAt: expect.any(String) });
    expect(thread.replies).toHaveLength(1);
    expect(await reason(service.edit(as(agent), undefined, root.id, { text: "Back" }))).toBe("message_deleted");
    expect(await reason(service.remove(as(agent), undefined, root.id, {}))).toBe("message_deleted");
  });

  it("sets labels with compare-and-set and caps the count", async () => {
    const root = await service.post(as(owner), undefined, { channel: "dev", text: "Bug", labels: { kind: "bug" } });
    await service.label(as(agent), undefined, root.id, { set: { pr: "#3501" }, if: { kind: "bug" } });
    expect(await reason(service.label(as(agent), undefined, root.id, { set: { kind: "feature" }, if: { kind: "docs" } }))).toBe("label_conflict");
    expect(await reason(service.label(as(agent), undefined, root.id, { set: { owner: "me" }, ifUnset: ["pr"] }))).toBe("label_conflict");
    await service.label(as(agent), undefined, root.id, { unset: ["kind"] });
    expect((await service.getThread(as(owner), undefined, root.id)).root.labels).toEqual({ pr: "#3501" });
    expect(await reason(service.label(as(agent), undefined, root.id, { set: { "matrix.depth": "1" } }))).toBe("reserved_label");
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`k${index}`, "v"]));
    expect(await reason(service.label(as(agent), undefined, root.id, { set: many }))).toBe("limit_reached");
    expect(events.filter((event) => event.type === "labels.changed")).toHaveLength(2);
  });

  it("keeps one reaction per emoji per actor", async () => {
    const root = await service.post(as(owner), undefined, { channel: "dev", text: "Ship it" });
    await service.react(as(agent), undefined, root.id, { emoji: "👍", on: true });
    await service.react(as(agent), undefined, root.id, { emoji: "👍", on: true });
    await service.react(as(owner), undefined, root.id, { emoji: "👍", on: true });
    expect((await service.getThread(as(owner), undefined, root.id)).root.reactions).toEqual([{ emoji: "👍", actors: ["agent:chat_abc", "user:owner_1"] }]);
    await service.react(as(agent), undefined, root.id, { emoji: "👍", on: false });
    expect((await service.getThread(as(owner), undefined, root.id)).root.reactions).toEqual([{ emoji: "👍", actors: ["user:owner_1"] }]);
    expect(events.filter((event) => event.type.startsWith("reaction."))).toHaveLength(3);
  });

  it("lists threads newest activity first with scope, label, author and text filters", async () => {
    const a = await service.post(as(owner), undefined, { channel: "security/findings", text: "Audit", labels: { kind: "security" } });
    tick();
    const b = await service.post(as(agent), undefined, { channel: "security/triage", text: "Triage spike" });
    tick();
    await service.post(as(owner), undefined, { channel: "dev", text: "Login flake" });
    tick();
    await service.post(as(agent), undefined, { channel: "security/findings", text: "Looking", re: a.id });
    const ids = async (query: Parameters<MessageBoardService["listThreads"]>[2]) =>
      (await service.listThreads(as(owner), undefined, query)).map((thread) => thread.root.text);
    expect(await ids({ channel: "*", limit: 50 })).toEqual(["Audit", "Login flake", "Triage spike"]);
    expect(await ids({ channel: "security/", limit: 50 })).toEqual(["Audit", "Triage spike"]);
    expect(await ids({ channel: "security", limit: 50 })).toEqual([]);
    expect(await ids({ channel: "*", label: "kind=security|bug", limit: 50 })).toEqual(["Audit"]);
    expect(await ids({ channel: "*", by: agent.id, limit: 50 })).toEqual(["Triage spike"]);
    expect(await ids({ channel: "*", text: "LOGIN", limit: 50 })).toEqual(["Login flake"]);
    expect(await ids({ channel: "*", limit: 1 })).toEqual(["Audit"]);
    expect(b.id).toBeTruthy();
  });

  it("tracks unread threads per viewer", async () => {
    const root = await service.post(as(agent), undefined, { channel: "dev", text: "Finding" });
    await service.post(as(owner), undefined, { channel: "dev", text: "Mine" });
    expect((await service.listChannels(as(owner))).find((channel) => channel.path === "dev")).toMatchObject({ unread: 1, threadCount: 2 });
    tick();
    await service.markRead(as(owner), undefined, root.id);
    expect((await service.listChannels(as(owner)))[0]!.unread).toBe(0);
    tick();
    await service.post(as(agent), undefined, { channel: "dev", text: "Update", re: root.id });
    expect((await service.listThreads(as(owner), undefined, { channel: "dev", limit: 50 })).find((thread) => thread.root.id === root.id)!.unread).toBe(true);
  });

  it("reads messages by label (message or root), mention, author and cursor", async () => {
    const root = await service.post(as(owner), undefined, { channel: "dev", text: "Bug", labels: { kind: "bug" } });
    const reply = await service.post(as(agent), undefined, { channel: "dev", text: "@reviewer please look", re: root.id });
    await service.post(as(owner), undefined, { channel: "ops", text: "Unrelated" });
    const texts = async (query: Parameters<MessageBoardService["listMessages"]>[2]) =>
      (await service.listMessages(as(owner), undefined, query)).map((message) => message.text);
    expect(await texts({ label: "kind=bug", limit: 50 })).toEqual(["Bug", "@reviewer please look"]);
    expect(await texts({ mentions: "reviewer", limit: 50 })).toEqual(["@reviewer please look"]);
    expect(await texts({ re: root.id, limit: 50 })).toEqual(["@reviewer please look"]);
    expect(await texts({ after: reply.id, limit: 50 })).toEqual(["Unrelated"]);
    expect(await texts({ by: agent.id, channel: "dev", limit: 50 })).toEqual(["@reviewer please look"]);
  });

  it("creates channels explicitly once and lists actors", async () => {
    await service.createChannel(as(owner), undefined, "projects/matrix-os");
    expect(await reason(service.createChannel(as(owner), undefined, "projects/matrix-os"))).toBe("channel_exists");
    await service.post(as(agent), undefined, { channel: "dev", text: "Hi" });
    expect((await service.listActors(as(owner))).map((actor) => actor.id)).toEqual(["agent:chat_abc"]);
  });

  it("rate limits writes per actor", async () => {
    const limited = new MessageBoardService(db, { now: () => new Date(clock), limits: { writesPerMinute: 2 } });
    await limited.post(as(agent), undefined, { channel: "dev", text: "1" });
    await limited.post(as(agent), undefined, { channel: "dev", text: "2" });
    expect(await reason(limited.post(as(agent), undefined, { channel: "dev", text: "3" }))).toBe("rate_limited");
    await limited.post(as(owner), undefined, { channel: "dev", text: "other actor" });
    tick(2);
    await limited.post(as(agent), undefined, { channel: "dev", text: "later" });
  });
});
