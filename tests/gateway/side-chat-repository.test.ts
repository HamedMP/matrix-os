import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { SideChatNotFoundError, SideChatRepository } from "../../packages/gateway/src/chat/side-chat-repository.js";

const owner = { type: "personal" as const, ownerId: "user_side" };
let pglite: Awaited<ReturnType<typeof createTestPGlite>>;
let chats: ChatRepository;
let side: SideChatRepository;

beforeEach(async () => {
  pglite = await createTestPGlite();
  chats = new ChatRepository(pglite.dialect);
  await chats.bootstrap();
  side = new SideChatRepository(chats.kysely);
});
afterEach(async () => { await chats.kysely.destroy(); });

it("saves a child transcript using the latest committed main chat without changing its messages", async () => {
  const chat = await chats.create(owner, { id: "chat_side_parent", clientRequestId: "req_side_parent", title: "Main" });
  await chats.kysely.insertInto("chat_messages").values({
    id: "msg_side_parent", chat_id: chat.chat.id, seq: 1, role: "user", purpose: "ai_request", state: "committed",
    turn_id: null, run_id: null, actor_id: null, parts: [{ type: "text", text: "Committed context" }],
    byte_count: 17, search_text: "Committed context", created_at: new Date(),
  }).execute();
  const created = await side.create(owner, chat.chat.id);
  expect(created.threadId).toMatch(/^side_/);
  const generate = vi.fn(async (prompt: string) => ({ text: prompt.includes("Committed context") ? "Side answer" : "Wrong context" }));
  const answered = await side.ask(owner, chat.chat.id, { clientRequestId: "req_side_turn", text: "Question" }, generate);
  expect(answered.messages.map(message => [message.role, message.content])).toEqual([["user", "Question"], ["assistant", "Side answer"]]);
  expect(await chats.kysely.selectFrom("chat_messages").select("id").where("chat_id", "=", chat.chat.id).execute()).toHaveLength(1);
  await side.ask(owner, chat.chat.id, { clientRequestId: "req_side_turn", text: "Question" }, generate);
  expect(generate).toHaveBeenCalledTimes(1);
  await expect(side.read({ type: "personal", ownerId: "another_user" }, chat.chat.id)).rejects.toBeInstanceOf(SideChatNotFoundError);
});
