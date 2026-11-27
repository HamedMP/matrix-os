import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";
import { createGoogleContextStore } from "../../packages/gateway/src/google-data/runtime/contexts.js";
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

it("keeps newest main context when the side transcript is long", async () => {
  const chat = await chats.create(owner, { id: "chat_side_long", clientRequestId: "req_side_long", title: "Main" });
  await chats.kysely.insertInto("chat_messages").values({
    id: "msg_side_recent", chat_id: chat.chat.id, seq: 1, role: "user", purpose: "ai_request", state: "committed",
    turn_id: null, run_id: null, actor_id: null, parts: [{ type: "text", text: "RECENT_MAIN_CONTEXT" }],
    byte_count: 19, search_text: "RECENT_MAIN_CONTEXT", created_at: new Date(),
  }).execute();
  const thread = (await side.create(owner, chat.chat.id)).threadId!;
  await chats.kysely.insertInto("chat_side_messages").values(Array.from({ length: 40 }, (_, index) => ({
    thread_id: thread, seq: index + 1, role: "assistant" as const, content: "x".repeat(2_000),
    client_request_id: `req_side_history_${index}`, created_at: new Date(),
  }))).execute();
  const generate = vi.fn(async (prompt: string) => ({ text: "Answer" }));
  await side.ask(owner, chat.chat.id, { clientRequestId: "req_side_latest", text: "Question" }, generate);
  expect(generate.mock.calls[0]?.[0]).toContain("RECENT_MAIN_CONTEXT");
});

it("withholds Side Chat on Gmail-marked parents and erases old answers without erasing owner questions", async () => {
  const { chat } = await chats.create(owner, { id: "chat_side_gmail", clientRequestId: "req_side_gmail", title: "Main" });
  const { chat: ordinary } = await chats.create(owner, { id: "chat_side_ordinary", clientRequestId: "req_side_ordinary", title: "Other" });
  const generate = vi.fn(async () => ({ text: "Synthetic Side Chat answer" }));
  for (const id of [chat.id, ordinary.id]) {
    await side.create(owner, id);
    await side.ask(owner, id, { clientRequestId: "req_old_answer", text: "Owner question" }, generate);
  }
  const contexts = createGoogleContextStore(chats.kysely);
  await contexts.migrate();
  const account = "10000000-0000-4000-8000-000000000001";
  const deadline = new Date(Date.now() + 60_000).toISOString();
  await contexts.mark({ ownerId: owner.ownerId, chatId: chat.id, googleAccountId: account,
    consentId: "consent_side", profileId: "profile_side", profileRevision: 1, purposeId: "assistant",
    expiresAt: deadline, retentionDeadline: deadline });

  await expect(side.read(owner, chat.id)).rejects.toThrow();
  await expect(side.ask(owner, chat.id, { clientRequestId: "req_new_answer", text: "Question" }, generate)).rejects.toThrow();
  expect(generate).toHaveBeenCalledTimes(2);
  await contexts.beginPurge(owner.ownerId, account);

  const rows = await chats.kysely.selectFrom("chat_side_messages as m")
    .innerJoin("chat_side_threads as t", "t.id", "m.thread_id").select("m.role")
    .where("t.chat_id", "=", chat.id).execute();
  expect(rows).toEqual([{ role: "user" }]);
  expect((await side.read(owner, ordinary.id)).messages).toHaveLength(2);
});
