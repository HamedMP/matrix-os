// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { mergeLoadedChatHistory, useCanonicalChatHistory } from "../../packages/ui/src/chat/use-canonical-chat-history";
import { applyCanonicalChatContent } from "../../packages/ui/src/canonical-chat-content";

function page(chatId: string, seqs: number[], cursor?: string, revision = 1): CanonicalChatDetailResponse {
  return { record: { chat: { id: chatId, ownerScope: { type: "personal", ownerId: "owner" }, title: "History", titleVersion: 0, lifecycle: "active", attention: "none", revision, messageCount: 254, createdAt: "2026-10-18T00:00:00Z", updatedAt: "2026-10-18T00:00:00Z" } },
    messages: seqs.map(seq => ({ id: `msg_${seq}`, chatId, seq, role: "user", state: "committed", parts: [{ type: "text", text: `Message ${seq}` }], createdAt: "2026-10-18T00:00:00Z" })), turns: [], runs: [], activities: [], ...(cursor ? { nextCursor: cursor } : {}) };
}
it("retains earlier loaded messages across a fresh snapshot without replacing fresh metadata", () => {
  const fresh = page("chat_one", [4, 5], "before4", 2);
  const merged = mergeLoadedChatHistory(fresh, page("chat_one", [1, 2, 3, 4], undefined));
  expect(merged.messages.map(m => m.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(merged.record.chat.revision).toBe(2);
  expect(merged.nextCursor).toBeUndefined();
  expect(mergeLoadedChatHistory(fresh, page("chat_other", [1]))).toBe(fresh);
});
it("does not lose an expanded history window when a new message streams in", () => {
  const loaded = page("chat_one", Array.from({ length: 254 }, (_, i) => i + 1));
  const incoming = page("chat_one", [255], undefined, 2);
  const result = applyCanonicalChatContent(loaded, { type: "chat.content", event: { chatId: "chat_one", revision: 2, cursor: 2, eventType: "run.message", createdAt: "2026-10-18T00:00:00Z" }, content: { record: incoming.record, messages: incoming.messages } });
  expect(result?.messages).toHaveLength(255);
  expect(result?.messages[0]?.seq).toBe(1);
});
it("loads earlier history, keeps newest data, and ignores a result after switching chats", async () => {
  let value = page("chat_one", [3, 4], "before3");
  const update = vi.fn((apply) => { value = apply(value); });
  let resolve!: (value: CanonicalChatDetailResponse) => void;
  const loadPage = vi.fn(() => new Promise<CanonicalChatDetailResponse>(r => { resolve = r; }));
  const hook = renderHook(({ detail }) => useCanonicalChatHistory({ detail, activeChatId: detail.record.chat.id, loadPage, update }), { initialProps: { detail: value } });
  let task!: Promise<void>;
  act(() => { task = hook.result.current.loadEarlier(); });
  await act(async () => { resolve(page("chat_one", [1, 2])); await task; });
  expect(value.messages.map(m => m.seq)).toEqual([1, 2, 3, 4]);
  expect(value.nextCursor).toBeUndefined();
  hook.rerender({ detail: page("chat_one", [3, 4], "before3") });
  act(() => { task = hook.result.current.loadEarlier(); });
  hook.rerender({ detail: page("chat_other", [1]) });
  await act(async () => { resolve(page("chat_one", [1, 2])); await task; });
  expect(update).toHaveBeenCalledTimes(1);
  hook.unmount();
});
it("keeps existing messages on failure and allows a safe retry", async () => {
  let value: CanonicalChatDetailResponse | null = page("chat_one", [3, 4], "before3");
  const loadPage = vi.fn().mockRejectedValueOnce(new Error("private upstream details")).mockResolvedValueOnce(page("chat_one", [1, 2]));
  const update = (apply: (current: CanonicalChatDetailResponse | null) => CanonicalChatDetailResponse | null) => { value = apply(value); };
  const hook = renderHook(() => useCanonicalChatHistory({ detail: value, activeChatId: "chat_one", loadPage, update }));
  await act(async () => { await hook.result.current.loadEarlier(); });
  expect(value?.messages.map(m => m.seq)).toEqual([3, 4]);
  expect(hook.result.current.error).toBe("Earlier messages could not be loaded. Try again.");
  await act(async () => { await hook.result.current.loadEarlier(); });
  expect(value?.messages.map(m => m.seq)).toEqual([1, 2, 3, 4]);
  expect(hook.result.current.error).toBeNull();
  hook.unmount();
});
it("rejects stale history when the computer changes but the Chat id stays the same", async () => {
  const detail = page("chat_one", [3, 4], "before3");
  const update = vi.fn();
  let resolve!: (value: CanonicalChatDetailResponse) => void;
  const loadPage = vi.fn(() => new Promise<CanonicalChatDetailResponse>(r => { resolve = r; }));
  const hook = renderHook(({ loader }) => useCanonicalChatHistory({ detail, activeChatId: "chat_one", loadPage: loader, update }), { initialProps: { loader: loadPage } });
  let task!: Promise<void>;
  act(() => { task = hook.result.current.loadEarlier(); });
  hook.rerender({ loader: vi.fn() });
  await act(async () => { resolve(page("chat_one", [1, 2])); await task; });
  expect(update).not.toHaveBeenCalled();
  hook.unmount();
});
