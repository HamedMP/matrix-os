// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useGettingStartedDestination } from "../../shell/src/components/onboarding/use-getting-started-destination.js";

function chat() {
  return { newChat: vi.fn(async () => {}), requestComposerDraft: vi.fn(), switchConversation: vi.fn() };
}

describe("web Getting started destinations", () => {
  it("opens a fresh chat with a try prompt typed in, unsent", async () => {
    const state = chat();
    const open = vi.fn();
    const { result } = renderHook(() => useGettingStartedDestination(state as never, open));
    result.current({ kind: "chat", prompt: "Find emails that need a reply. Don't send anything." });
    expect(open).toHaveBeenCalledWith("__chat__", "Chat");
    await waitFor(() => expect(state.requestComposerDraft).toHaveBeenCalledWith("Find emails that need a reply. Don't send anything.", { merge: true }));
    expect(state.newChat).toHaveBeenCalled();
  });

  it("opens a bot's own chat and App Gallery", () => {
    const state = chat();
    const open = vi.fn();
    const { result } = renderHook(() => useGettingStartedDestination(state as never, open));
    result.current({ kind: "chat", chatId: "chat_bot0001" });
    expect(state.switchConversation).toHaveBeenCalledWith("chat_bot0001");
    result.current({ kind: "app-gallery" });
    expect(open).toHaveBeenLastCalledWith(expect.stringContaining("app-gallery"), "App Gallery");
    expect(state.requestComposerDraft).not.toHaveBeenCalled();
  });
});
