// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useLinkedChatSelection } from "@/hooks/useLinkedChatSelection";

describe("useLinkedChatSelection", () => {
  it("selects a linked Chat that only appears after hydration", () => {
    const select = vi.fn();
    const { rerender } = renderHook((props: { chatId: string | null; activeChatId?: string }) => useLinkedChatSelection({
      chatId: props.chatId, blocked: false, activeChatId: props.activeChatId, select,
    }), { initialProps: { chatId: null as string | null, activeChatId: "chat_newest" } });
    expect(select).not.toHaveBeenCalled();
    rerender({ chatId: "chat_linked", activeChatId: "chat_newest" });
    expect(select).toHaveBeenCalledExactlyOnceWith("chat_linked");
  });

  it("never overrides a later choice and skips an already-selected Chat", () => {
    const select = vi.fn();
    const { rerender } = renderHook((props: { activeChatId?: string }) => useLinkedChatSelection({
      chatId: "chat_linked", blocked: false, activeChatId: props.activeChatId, select,
    }), { initialProps: { activeChatId: "chat_linked" as string | undefined } });
    expect(select).not.toHaveBeenCalled();
    rerender({ activeChatId: "chat_other" });
    expect(select).not.toHaveBeenCalled();
  });

  it("defers to a recipe draft or shared view", () => {
    const select = vi.fn();
    renderHook(() => useLinkedChatSelection({ chatId: "chat_linked", blocked: true, activeChatId: undefined, select }));
    expect(select).not.toHaveBeenCalled();
  });
});
