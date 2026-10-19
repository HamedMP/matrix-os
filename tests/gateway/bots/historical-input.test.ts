import { expect, it, vi } from "vitest";
import { createBotInputHistoryReader } from "../../../packages/gateway/src/bots/historical-input.js";
import type { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
const input = { ownerId: "owner_1", chatId: "chat_1", runId: "run_2", signal: new AbortController().signal };
const part = { type: "attachment_reference", kind: "file", attachmentId: "att_1", label: "fixture", mimeType: "text/plain", ownerReference: "temporary/desktop-chat/fixture.txt" };
function fixture() {
  const record = { chat: { id: input.chatId, ownerScope: { type: "personal", ownerId: input.ownerId }, lifecycle: "active" }, activeRun: { runId: input.runId, turnId: "cturn_2" } };
  const context = { chat: record, turn: { id: "cturn_2", chatId: input.chatId, baseMessageSeq: 3 }, latestRun: { id: input.runId, turnId: "cturn_2", chatId: input.chatId, historyBoundarySeq: 3, status: "running" } };
  const message = { id: "msg_1", chatId: input.chatId, seq: 1, actorId: input.ownerId, turnId: "cturn_1", role: "user", state: "committed", purpose: "ai_request", parts: [part] };
  const detail = { record, messages: [message], runs: [{ chatId: input.chatId, turnId: "cturn_1" }] };
  const repository = { get: vi.fn(async () => record), getTurnRunContext: vi.fn(async () => context), getDetailPage: vi.fn(async () => detail) };
  return { record, context, message, detail, repository, read: createBotInputHistoryReader(repository as unknown as Pick<ChatRepository, "get" | "getTurnRunContext" | "getDetailPage">) };
}
it("reads only canonical same-owner user uploads from the immutable bounded prefix", async () => {
  const f = fixture(); const history = await f.read(input);
  expect(history.references).toEqual([{ part, seq: 1 }]);
  expect(f.repository.get).toHaveBeenCalledWith({ type: "personal", ownerId: input.ownerId }, input.chatId);
  expect(f.repository.getDetailPage).toHaveBeenCalledWith({ type: "personal", ownerId: input.ownerId }, input.chatId, { beforeSeq: 4, limit: 40 });
  f.context.latestRun.historyBoundarySeq = 4;
  await expect(history.assertCurrent()).rejects.toMatchObject({ code: "stale_generation" });
});
it.each([
  { role: "assistant" }, { role: "tool" }, { role: "system" }, { purpose: "discussion" }, { state: "pending" },
  { seq: 4 }, { chatId: "chat_other" }, { actorId: "owner_other" }, { turnId: "imported_turn" },
  { parts: [{ ...part, ownerReference: "projects/other/secret" }] },
])("never rehydrates non-authoritative messages %j", async change => {
  const f = fixture(); Object.assign(f.message, change); expect((await f.read(input)).references).toEqual([]);
});
it.each([
  (f: ReturnType<typeof fixture>) => { f.record.chat.lifecycle = "archived"; },
  f => { f.record.chat.ownerScope.ownerId = "foreign"; },
  f => { f.record.chat.ownerScope.type = "org"; },
  f => { Object.assign(f.record.chat, { collaboration: { visibility: "private" } }); },
  f => { f.record.activeRun.runId = "run_other"; },
  f => { f.context.latestRun.id = "run_other"; },
  f => { f.context.latestRun.historyBoundarySeq = 2; },
  f => { f.context.latestRun.status = "completed"; },
])("rejects changed owner, visibility, active/latest run, boundary and terminal status", async change => {
  const f = fixture(); change(f); await expect(f.read(input)).rejects.toMatchObject({ code: "stale_generation" });
});
it("fails closed when the active identity changes during history I/O or cancellation", async () => {
  const f = fixture(); f.repository.getDetailPage.mockImplementation(async () => { f.record.activeRun.runId = "run_other"; return f.detail; });
  await expect(f.read(input)).rejects.toMatchObject({ code: "stale_generation" });
  const g = fixture(); const controller = new AbortController();
  g.repository.getDetailPage.mockImplementation(async () => { controller.abort(); return g.detail; });
  await expect(g.read({ ...input, signal: controller.signal })).rejects.toMatchObject({ code: "stale_generation" });
});
it("caps observed messages even if a repository returns too many, newest first", async () => {
  const f = fixture(); f.context.turn.baseMessageSeq = f.context.latestRun.historyBoundarySeq = 80;
  f.detail.messages = Array.from({ length: 80 }, (_, i) => ({ ...f.message, seq: i + 1 }));
  const history = await f.read(input); expect(history.references).toHaveLength(40);
  expect(history.references[0]?.seq).toBe(80); expect(history.references.at(-1)?.seq).toBe(41);
});
it("caps candidates at forty references even when each recent message has sixty-four uploads", async () => {
  const f = fixture(); f.context.turn.baseMessageSeq = f.context.latestRun.historyBoundarySeq = 40;
  f.detail.messages = Array.from({ length: 40 }, (_, i) => ({ ...f.message, seq: i + 1,
    parts: Array.from({ length: 64 }, (_, j) => ({ ...part, attachmentId: `att_${i}_${j}`,
      ownerReference: `temporary/desktop-chat/${i}-${j}.txt` })) }));
  const history = await f.read(input);
  expect(history.references).toHaveLength(40);
  expect(history.references.every(reference => reference.seq === 40)).toBe(true);
});
