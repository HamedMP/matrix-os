// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatAgentsRailSection } from "../../packages/ui/src/chat-agents/ChatAgentsRailSection.js";
import { ChatAgentsWorkspace, useChatAgentsNavigation } from "../../packages/ui/src/chat-agents/ChatAgentsNavigation.js";
import { clientFixture, saved } from "./chat-agents-fixture";
import type { ChatAgentClient } from "../../packages/ui/src/chat-agents/client.js";
afterEach(cleanup);
function setup(lookup: () => Promise<string | null>, recipeBot = true) {
  const base = clientFixture();
  base.list.mockResolvedValue({ enabled: true, agents: [{ ...saved, ...(recipeBot ? { recipeRef: { recipeId: "writing-bot", version: "1" } } : {}) }] });
  const directChat = vi.fn(lookup);
  const client = { ...base, bots: { directChat } } as unknown as ChatAgentClient;
  const onStartChat = vi.fn(), onOpenBotChat = vi.fn();
  render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client} onStartChat={onStartChat} onOpenBotChat={onOpenBotChat} /></ChatAgentsWorkspace>);
  return { directChat, onStartChat, onOpenBotChat };
}
describe("bot sidebar navigation", () => {
  it("opens the bound direct chat instead of attaching a bot to an ordinary Agent draft", async () => {
    const handlers = setup(async () => "chat_bot_direct");
    fireEvent.click(await screen.findByRole("button", { name: `Chat with ${saved.name}` }));
    await waitFor(() => expect(handlers.onOpenBotChat).toHaveBeenCalledWith("chat_bot_direct"));
    expect(handlers.directChat).toHaveBeenCalledWith(saved.id);
    expect(handlers.onStartChat).not.toHaveBeenCalled();
  });
  it.each([async () => null, async () => { throw new Error("private provider details"); }])("shows a safe error without falling back to Codex", async (lookup) => {
    const handlers = setup(lookup);
    fireEvent.click(await screen.findByRole("button", { name: `Chat with ${saved.name}` }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Could not open this bot’s Chat. Try again.");
    expect(handlers.onStartChat).not.toHaveBeenCalled();
    expect(handlers.onOpenBotChat).not.toHaveBeenCalled();
  });
  it("preserves ordinary Agent drafts", async () => {
    const handlers = setup(async () => null, false);
    fireEvent.click(await screen.findByRole("button", { name: `Chat with ${saved.name}` }));
    await waitFor(() => expect(handlers.onStartChat).toHaveBeenCalledWith("", [{ kind: "agent", id: saved.id, label: saved.name, revision: "1" }]));
    expect(handlers.directChat).toHaveBeenCalledWith(saved.id);
  });
  it("finishes the host's accepted navigation when the host closes Agents", async () => {
    const base = clientFixture();
    base.list.mockResolvedValue({ enabled: true, agents: [{ ...saved, recipeRef: { recipeId: "writing-bot", version: "1" } }] });
    const client = { ...base, bots: { directChat: vi.fn(async () => "chat_bot_direct") } } as unknown as ChatAgentClient;
    const onOpen = vi.fn(), openedChat = vi.fn();
    function Host() {
      const navigation = useChatAgentsNavigation();
      return <ChatAgentsRailSection client={client} onOpen={onOpen} onOpenBotChat={chatId => {
        navigation?.close(); openedChat(chatId);
      }} />;
    }
    render(<ChatAgentsWorkspace><Host /></ChatAgentsWorkspace>);
    fireEvent.click(await screen.findByRole("button", { name: `Chat with ${saved.name}` }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledOnce());
    expect(openedChat).toHaveBeenCalledWith("chat_bot_direct");
  });
  it("discards a pending binding lookup after a newer navigation", async () => {
    let finish!: (chatId: string) => void;
    const base = clientFixture();
    base.list.mockResolvedValue({ enabled: true, agents: [{ ...saved, recipeRef: { recipeId: "writing-bot", version: "1" } }] });
    const client = { ...base, bots: { directChat: vi.fn(() => new Promise<string>(resolve => { finish = resolve; })) } } as unknown as ChatAgentClient;
    const openedChat = vi.fn();
    function Host() {
      const navigation = useChatAgentsNavigation();
      return <><button onClick={() => navigation?.close()}>Open another Chat</button><ChatAgentsRailSection client={client} onOpenBotChat={openedChat} /></>;
    }
    render(<ChatAgentsWorkspace><Host /></ChatAgentsWorkspace>);
    fireEvent.click(await screen.findByRole("button", { name: `Chat with ${saved.name}` }));
    fireEvent.click(screen.getByRole("button", { name: "Open another Chat" }));
    finish("chat_bot_direct");
    await waitFor(() => expect(screen.getByRole("button", { name: `Chat with ${saved.name}` }).getAttribute("aria-busy")).toBe("false"));
    expect(openedChat).not.toHaveBeenCalled();
  });
});
