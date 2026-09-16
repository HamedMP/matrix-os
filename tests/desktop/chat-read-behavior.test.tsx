// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatReadState } from "../../packages/ui/src/chat/use-chat-read-state.js";

beforeEach(() => { vi.spyOn(document, "hasFocus").mockReturnValue(true); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const state = { unread: true, markedUnread: false, version: 0, readThroughSeq: 0, latestIncomingSeq: 2 };

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
