import { beforeEach, describe, expect, it } from "vitest";
import { chatInspectorLayoutKey, useChatInspectorLayout } from "@desktop/renderer/src/stores/chat-inspector-layout";

beforeEach(() => useChatInspectorLayout.setState({ entries: [] }));

describe("Chat inspector layout", () => {
  it("isolates a saved width and tab selection by verified user, runtime, and chat", () => {
    const key = chatInspectorLayoutKey("user_a", "runtime_a", "chat_a");
    useChatInspectorLayout.getState().update(key, { width: 620, selectedTabId: "browser", openTabIds: ["files", "browser"] });
    expect(useChatInspectorLayout.getState().get(key)).toEqual({ width: 620, selectedTabId: "browser", openTabIds: ["files", "browser"] });
    expect(useChatInspectorLayout.getState().get(chatInspectorLayoutKey("user_b", "runtime_a", "chat_a"))).toBeNull();
    expect(useChatInspectorLayout.getState().get(chatInspectorLayoutKey("user_a", "runtime_b", "chat_a"))).toBeNull();
    expect(useChatInspectorLayout.getState().get(chatInspectorLayoutKey("user_a", "runtime_a", "chat_b"))).toBeNull();
  });

  it("bounds saved layouts to the latest 32 chats", () => {
    for (let index = 0; index < 40; index += 1) {
      useChatInspectorLayout.getState().update(chatInspectorLayoutKey("user_a", "runtime_a", `chat_${index}`), { width: 400 + index });
    }
    expect(useChatInspectorLayout.getState().entries).toHaveLength(32);
    expect(useChatInspectorLayout.getState().get(chatInspectorLayoutKey("user_a", "runtime_a", "chat_0"))).toBeNull();
  });
});
