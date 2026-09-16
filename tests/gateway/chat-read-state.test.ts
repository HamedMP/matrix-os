import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatRoutes } from "../../packages/gateway/src/chat/routes.js";
import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";

const owner = { type: "personal" as const, ownerId: "reader" };
let repository: ChatRepository;
let chatId: string;

beforeEach(async () => {
  repository = new ChatRepository((await KyselyPGlite.create()).dialect);
  await repository.bootstrap();
  const record = await repository.create(owner, { id: "chat_read_test", clientRequestId: "req_read_test", title: "Read me" });
  chatId = record.chat.id;
});
afterEach(async () => { await repository.kysely.destroy(); });

async function append(seq: number, role: "assistant" | "user" = "assistant") {
  await repository.kysely.insertInto("chat_messages").values({
    id: `msg_read_${seq}`, chat_id: chatId, seq, role, state: "committed",
    turn_id: null, run_id: null, parts: JSON.stringify([{ type: "text", text: "Hello" }]),
    created_at: new Date().toISOString(), byte_count: 5, search_text: "Hello", purpose: "ai_request",
  }).execute();
  await repository.kysely.updateTable("chats").set({ message_count: seq }).where("id", "=", chatId).execute();
}

describe("durable chat read state", () => {
  it("persists manual unread across reads and pin changes, without reordering the chat", async () => {
    const initial = await repository.get(owner, chatId);
    const unread = await repository.updateReadState(owner, chatId, { type: "mark_unread" });
    expect(unread.readState).toMatchObject({ unread: true, markedUnread: true, version: 1 });
    await repository.updateUserState(owner, chatId, { pinned: true });
    const saved = await repository.get(owner, chatId);
    expect(saved?.readState).toEqual(unread.readState);
    expect(saved?.chat.updatedAt).toBe(initial?.chat.updatedAt);
  });

  it("ignores stale automatic reads after a manual unread action", async () => {
    await append(1);
    await repository.updateReadState(owner, chatId, { type: "mark_unread" });
    const stale = await repository.updateReadState(owner, chatId, { type: "mark_read", throughSeq: 1, baseVersion: 0 });
    expect(stale.readState?.unread).toBe(true);
    const read = await repository.updateReadState(owner, chatId, { type: "mark_read", throughSeq: 1, baseVersion: 1 });
    expect(read.readState).toMatchObject({ unread: false, markedUnread: false, readThroughSeq: 1 });
  });

  it("does not clear a new reply that arrived after the client's displayed snapshot", async () => {
    await append(1);
    await append(2);
    const read = await repository.updateReadState(owner, chatId, { type: "mark_read", throughSeq: 1, baseVersion: 0 });
    expect(read.readState).toMatchObject({ unread: true, latestIncomingSeq: 2, readThroughSeq: 1 });
  });

  it("ignores outgoing messages and never moves a read cursor backwards", async () => {
    await append(1, "user");
    expect((await repository.get(owner, chatId))?.readState?.unread).toBe(false);
    await append(2);
    await repository.updateReadState(owner, chatId, { type: "mark_read", throughSeq: 2, baseVersion: 0 });
    const stale = await repository.updateReadState(owner, chatId, { type: "mark_read", throughSeq: 1, baseVersion: 0 });
    expect(stale.readState).toMatchObject({ unread: false, readThroughSeq: 2 });
  });

  it("rejects another owner and future cursors", async () => {
    await expect(repository.updateReadState({ ...owner, ownerId: "stranger" }, chatId, { type: "mark_unread" })).rejects.toThrow();
    await expect(repository.updateReadState(owner, chatId, { type: "mark_read", throughSeq: 100, baseVersion: 0 })).rejects.toThrow();
  });

  it("filters unread before pagination and preserves choices on bootstrap", async () => {
    await repository.create(owner, { id: "chat_newer", clientRequestId: "req_newer", title: "Newer" });
    await repository.updateReadState(owner, chatId, { type: "mark_unread" });
    await repository.bootstrap();
    const page = await repository.list(owner, { limit: 1, unreadOnly: true });
    expect(page.items.map((record) => record.chat.id)).toEqual([chatId]);
    expect(page.nextCursor).toBeUndefined();
  });

  it("wires authenticated mutations to persistence and list projections", async () => {
    const app = createCanonicalChatRoutes({
      service: createCanonicalChatService(repository),
      getPrincipal: () => ({ userId: owner.ownerId, source: "jwt" }),
    });
    const patch = (body: unknown, id = chatId) => app.request(`/api/chats/${id}/read-state`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await patch({ type: "mark_unread" })).status).toBe(200);
    const list = await app.request("/api/chats?unread=true&readStateVersion=1");
    expect((await list.json()).items[0].readState.unread).toBe(true);
    expect((await patch({ type: "mark_read", throughSeq: 0, baseVersion: 1 })).status).toBe(200);
    expect((await (await app.request("/api/chats?unread=true&readStateVersion=1")).json()).items).toEqual([]);
    expect((await patch({ type: "mark_read", throughSeq: -1, baseVersion: 1 })).status).toBe(400);
    expect((await patch({ type: "mark_unread", ownerId: "other" })).status).toBe(400);
    expect((await patch({ type: "mark_unread" }, "chat_missing")).status).toBe(404);
    expect((await patch({ type: "mark_unread", padding: "x".repeat(5000) })).status).toBe(413);
    expect((await app.request("/api/chats?unread=anything")).status).toBe(400);
  });
});
