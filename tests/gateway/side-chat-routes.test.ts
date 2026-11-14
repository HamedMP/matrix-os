import { expect, it, vi } from "vitest";
import { createSideChatRoutes } from "../../packages/gateway/src/chat/side-chat-routes.js";
import type { SideChatRepository } from "../../packages/gateway/src/chat/side-chat-repository.js";

it("checks the owner, validates bounded side turns, and returns only the saved side transcript", async () => {
  const snapshot = { threadId: "side_" + "a".repeat(32), messages: [] };
  const create = vi.fn(async () => snapshot);
  const read = vi.fn(async () => snapshot);
  const ask = vi.fn(async () => ({ ...snapshot, messages: [
    { seq: 1, role: "user", content: "Question", createdAt: "2026-11-12T00:00:00.000Z" },
    { seq: 2, role: "assistant", content: "Answer", createdAt: "2026-11-12T00:00:01.000Z" },
  ] }));
  const repository = { create, read, ask } as unknown as SideChatRepository;
  const generate = vi.fn(async () => ({ text: "Answer" }));
  const app = createSideChatRoutes({ repository, generate, getPrincipal: () => ({ userId: "owner_a", source: "jwt" }) });
  const created = await app.request("/api/chats/chat_a/side-chat", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(created.status).toBe(200);
  expect(create).toHaveBeenCalledWith({ type: "personal", ownerId: "owner_a" }, "chat_a");
  const answered = await app.request("/api/chats/chat_a/side-chat/turns", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientRequestId: "req_side_turn", text: "Question" }) });
  expect(answered.status).toBe(200);
  expect((await answered.json()).messages).toHaveLength(2);
  expect(ask).toHaveBeenCalledWith({ type: "personal", ownerId: "owner_a" }, "chat_a",
    { clientRequestId: "req_side_turn", text: "Question" }, generate);
  const invalid = await app.request("/api/chats/chat_a/side-chat/turns", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x".repeat(8_001) }) });
  expect(invalid.status).toBe(400);
  expect(ask).toHaveBeenCalledTimes(1);
});
