// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatReadState } from "../../packages/ui/src/chat/use-chat-read-state.js";
import { useCanonicalChatRouteController } from "@desktop/renderer/src/features/chat/use-canonical-chat-route-controller";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { routineReceiptReadFixture } from "../contracts/fixtures/canonical-chat";

beforeEach(() => { vi.spyOn(document, "hasFocus").mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const state = { unread: true, markedUnread: false, version: 0, readThroughSeq: 0, latestIncomingSeq: 2 };

it("acknowledges a committed scheduled result when opening its Chat", async () => {
  const messages = routineReceiptReadFixture("chat_one");
  const record = {
    chat: {
      id: "chat_one", ownerScope: { type: "personal" as const, ownerId: "owner_test" },
      title: "Scheduled Chat", lifecycle: "active" as const, attention: "none" as const,
      revision: 1, messageCount: messages.length,
      createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z",
    },
    readState: state,
  };
  const updateReadState = vi.fn(async () => record);
  const client = {
    list: vi.fn(async () => ({ items: [record] })),
    getDetail: vi.fn(async () => ({ record, messages, turns: [], runs: [], activities: [] })),
    updateReadState,
  } as unknown as CanonicalChatClient;
  renderHook(() => useCanonicalChatRouteController({
    client, projectId: null, active: true, initialChatId: record.chat.id,
  }));

  await waitFor(() => expect(updateReadState).toHaveBeenCalledWith(record.chat.id, {
    type: "mark_read", throughSeq: 2, baseVersion: 0,
  }));
});

it("reads a visible chat but preserves a later manual unread until it is reopened", async () => {
  const onRead = vi.fn(async () => true);
  const { rerender } = renderHook((props) => useChatReadState(props), { initialProps: {
    chatId: "chat_one", state, active: true, throughSeq: 2, onRead,
  } });
  await waitFor(() => expect(onRead).toHaveBeenCalledTimes(1));
  const manual = { ...state, markedUnread: true, version: 2 };
  rerender({ chatId: "chat_one", state: manual, active: true, throughSeq: 2, onRead });
  expect(onRead).toHaveBeenCalledTimes(1);
  rerender({ chatId: "chat_one", state: manual, active: false, throughSeq: 2, onRead });
  rerender({ chatId: "chat_one", state: manual, active: true, throughSeq: 2, onRead });
  await waitFor(() => expect(onRead).toHaveBeenLastCalledWith("chat_one", { type: "mark_read", throughSeq: 2, baseVersion: 2 }));
});

it("does not read a background window and retries when focused", async () => {
  vi.mocked(document.hasFocus).mockReturnValue(false);
  const onRead = vi.fn(async () => true);
  renderHook(() => useChatReadState({ chatId: "chat_one", state, active: true, throughSeq: 2, onRead }));
  expect(onRead).not.toHaveBeenCalled();
  vi.mocked(document.hasFocus).mockReturnValue(true);
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await waitFor(() => expect(onRead).toHaveBeenCalledTimes(1));
});

it("does not loop on failed reads, and retries on the next focus", async () => {
  const onRead = vi.fn(async () => false);
  renderHook(() => useChatReadState({ chatId: "chat_one", state, active: true, throughSeq: 2, onRead }));
  await waitFor(() => expect(onRead).toHaveBeenCalledTimes(1));
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await waitFor(() => expect(onRead).toHaveBeenCalledTimes(2));
});
