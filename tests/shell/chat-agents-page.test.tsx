// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp.js";
import { createBotClient } from "../../packages/ui/src/chat-agents/bots/client.js";
import { clientFixture, saved } from "../desktop/chat-agents-fixture";

vi.mock("@clerk/nextjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clerk/nextjs")>()),
  useOrganization: () => ({ organization: null }),
  useAuth: () => ({ userId: null, sessionId: null }),
}));

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Web Chat Agents page", () => {
  it.each([false, true])("submits the saved Agent identity from its rail entry (mobile=%s)", async (mobile) => {
    const base = clientFixture();
    const botChatId = "chat_saved_bot";
    const botRequest = vi.fn(async (path: string, method: string) => {
      if (path === `/api/chat-agents/${saved.id}/direct-chat` && (method === "GET" || method === "POST")) {
        return { chatId: botChatId };
      }
      if (path === `/api/chats/${botChatId}/bot` && method === "GET") return { agentId: saved.id };
      if (path === "/api/chats/chat_original/bot" && method === "GET") return { agentId: null };
      throw new Error(`Unexpected Bot request: ${method} ${path}`);
    });
    const client = { ...base, bots: createBotClient(botRequest) };
    client.list.mockResolvedValue({ enabled: true, agents: [saved] });
    const catalog = await client.catalog();
    const hermes = catalog.instances.find(instance => instance.id === saved.selection.instanceId)!;
    // Match the saved runtime's real requirement rather than inherited Codex permissions.
    hermes.supports = { ...hermes.supports, permissionModes: ["full_access"] };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(catalog)));
    const submit = vi.fn(async () => true);
    const props = { messages: [], sessionId: "chat_original" as string | undefined,
      busy: false, connected: true, conversations: [], onNewChat: vi.fn(),
      onSwitchConversation: vi.fn(), onSubmit: submit, agentClient: client, mobile };
    const view = render(<ChatApp {...props} />);
    const sourceDraft = await screen.findByRole("textbox", { name: "Message chat" });
    fireEvent.change(sourceDraft, { target: { value: "Keep the ordinary Chat draft" } });
    fireEvent.click(await screen.findByRole("button", { name: `Chat with ${saved.name}` }));
    await waitFor(() => expect(props.onSwitchConversation).toHaveBeenCalledWith(botChatId));
    expect(botRequest).toHaveBeenCalledWith(`/api/chat-agents/${saved.id}/direct-chat`, "POST", {});
    expect(props.onNewChat).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    view.rerender(<ChatApp {...props} sessionId={botChatId} />);
    const consent = await screen.findByRole("checkbox", { name: /Allow Full access/ });
    const input = await screen.findByRole("textbox", { name: "Message chat" });
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
    expect(document.querySelector("[data-slot='chat-session-header']")).toBeNull();
    expect(document.querySelectorAll(".matrix-bot-identity-bar")).toHaveLength(1);
    fireEvent.change(input, { target: { value: "Summarize these synthetic notes" } });
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("Summarize these synthetic notes", undefined,
      expect.objectContaining({ instanceId: saved.selection.instanceId, model: saved.selection.model,
        permissionMode: "full_access", resources: [{ kind: "agent", id: saved.id, label: saved.name, revision: String(saved.revision) }] })));
    await waitFor(() => expect(consent).toHaveProperty("checked", false));
    fireEvent.change(input, { target: { value: "A separate Bot request" } });
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    fireEvent.click(consent);
    view.rerender(<ChatApp {...props} />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Message chat" })).toHaveProperty("value", "Keep the ordinary Chat draft"));
    expect(screen.queryByRole("checkbox", { name: /Allow Full access/ })).toBeNull();
    view.rerender(<ChatApp {...props} sessionId={botChatId} />);
    expect(await screen.findByRole("checkbox", { name: /Allow Full access/ })).toHaveProperty("checked", false);
    expect(screen.getByRole("textbox", { name: "Message chat" })).toHaveProperty("value", "A separate Bot request");
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(botRequest.mock.calls.some(([path]) => /\/(authority|interactions|bot-tasks)$/.test(path))).toBe(false);
  });
  it.each([false, true])("preserves the transcript and draft across Templates and Agents management (mobile=%s)", async (mobile) => {
    const client = clientFixture();
    client.list.mockResolvedValue({ enabled: true, agents: [saved] });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(await client.catalog())));
    const submit = vi.fn();
    const props = { messages: [{ id: "msg_original", role: "user" as const, content: "Original message", timestamp: 1000 }],
      sessionId: "chat_original", busy: false, connected: true, conversations: [],
      onNewChat: vi.fn(), onSwitchConversation: vi.fn(), onSubmit: submit, agentClient: client, mobile };
    const view = render(<ChatApp {...props} />);
    const draft = screen.getByRole("textbox", { name: "Message chat" });
    fireEvent.change(draft, { target: { value: "Keep this draft" } });
    await waitFor(() => expect((draft as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.click(await screen.findByRole("button", { name: "Add new agent" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message chat" })).toBeNull();
    expect(draft.isConnected).toBe(true);
    expect(await screen.findByRole("region", { name: "Agent recipes" })).toBeTruthy();
    view.rerender(<ChatApp {...props} messages={[...props.messages,
      { id: "msg_live", role: "assistant", content: "Arrived while editing", timestamp: 2000 }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Close Agents" }));
    expect(screen.getByRole("textbox", { name: "Message chat" })).toBe(draft);
    expect((draft as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(screen.getByText("Original message")).toBeTruthy();
    expect(screen.getByText("Arrived while editing")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Agents", exact: true }));
    expect(await screen.findByRole("region", { name: "Agents", exact: true })).toBeTruthy();
    expect(await screen.findByRole("button", { name: `Edit ${saved.name}` })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Agent recipes" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message chat" })).toBeNull();
    expect(draft.isConnected).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close Agents" }));
    expect(screen.getByRole("textbox", { name: "Message chat" })).toBe(draft);
    expect((draft as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(screen.getByText("Original message")).toBeTruthy();
    expect(screen.getByText("Arrived while editing")).toBeTruthy();
    expect(props.onNewChat).not.toHaveBeenCalled();
    expect(props.onSwitchConversation).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("starts conversational Agent creation from a template in a fresh Chat without sending or losing the source draft", async () => {
    const client = clientFixture();
    client.list.mockResolvedValue({ enabled: true, agents: [] });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(await client.catalog())));
    const onNewChat = vi.fn();
    const props = { messages: [{ id: "msg_original", role: "user" as const, content: "Original message", timestamp: 1000 }],
      sessionId: "chat_original" as string | undefined, busy: false, connected: true, conversations: [],
      onNewChat, onSwitchConversation: vi.fn(), onSubmit: vi.fn(), agentClient: client };
    const view = render(<ChatApp {...props} />);
    const sourceDraft = screen.getByRole("textbox", { name: "Message chat" });
    fireEvent.change(sourceDraft, { target: { value: "Keep the original draft" } });
    fireEvent.click(await screen.findByRole("button", { name: "Add new agent" }));
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search recipes" }), { target: { value: "Account Research Desk" } });
    const buildInChat = await screen.findByRole("button", { name: "Use Account Research Desk" });
    expect(buildInChat.textContent).toBe("Build in Chat");
    fireEvent.click(buildInChat);
    expect(onNewChat).toHaveBeenCalledTimes(1);
    view.rerender(<ChatApp {...props} sessionId={undefined} messages={[]} />);
    const newDraft = await screen.findByRole("textbox", { name: "Message chat" });
    expect((newDraft as HTMLTextAreaElement).value).toContain("Help me create a Matrix agent");
    expect((newDraft as HTMLTextAreaElement).value).toContain("Account Research Desk");
    expect(screen.queryByRole("region", { name: "Agent recipes" })).toBeNull();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(client.create).not.toHaveBeenCalled();
    view.rerender(<ChatApp {...props} />);
    expect((await screen.findByRole("textbox", { name: "Message chat" }) as HTMLTextAreaElement).value).toBe("Keep the original draft");
    expect(screen.getByText("Original message")).toBeTruthy();
  });
});
