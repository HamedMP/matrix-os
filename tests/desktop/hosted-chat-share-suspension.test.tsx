// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useHostedChatShareSuspension } from "@desktop/renderer/src/features/chat/hosted-chat-share-suspension";

it("fences toolbar disclosure callbacks by exact Chat, client and runtime authority", () => {
  const client = {};
  const hook = renderHook(({ identity }) => useHostedChatShareSuspension(client, "chat_one", identity), { initialProps: { identity: "runtime:owner" } });
  const start = vi.fn(), failed = vi.fn();
  hook.result.current.report({ client: {}, chatId: "chat_one", start, failed });
  hook.result.current.start(); expect(start).not.toHaveBeenCalled();
  hook.result.current.report({ client, chatId: "other", start, failed });
  hook.result.current.start(); expect(start).not.toHaveBeenCalled();
  const release = hook.result.current.report({ client, chatId: "chat_one", start, failed });
  hook.result.current.start(); hook.result.current.failed();
  expect(start).toHaveBeenCalledOnce(); expect(failed).toHaveBeenCalledOnce();
  hook.rerender({ identity: "runtime:changed-owner" });
  hook.result.current.start(); hook.result.current.failed();
  expect(start).toHaveBeenCalledOnce(); expect(failed).toHaveBeenCalledOnce();
  release();
});

it("releases only the registration owned by the unmounting content", () => {
  const client = {};
  const hook = renderHook(() => useHostedChatShareSuspension(client, "chat_one", "runtime:owner"));
  const first = { client, chatId: "chat_one", start: vi.fn(), failed: vi.fn() };
  const second = { ...first, start: vi.fn() };
  const releaseFirst = hook.result.current.report(first);
  const releaseSecond = hook.result.current.report(second);
  releaseFirst(); hook.result.current.start();
  expect(first.start).not.toHaveBeenCalled(); expect(second.start).toHaveBeenCalledOnce();
  releaseSecond(); hook.result.current.start(); expect(second.start).toHaveBeenCalledOnce();
});
