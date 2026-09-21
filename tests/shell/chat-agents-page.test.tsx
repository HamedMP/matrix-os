// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp.js";
import { clientFixture, saved } from "../desktop/chat-agents-fixture";

vi.mock("@clerk/nextjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clerk/nextjs")>()),
  useOrganization: () => ({ organization: null }),
}));

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Web Chat Agents page", () => {
  it.each([false, true])("submits the saved Agent identity from its rail entry (mobile=%s)", async (mobile) => {
    const client = clientFixture();
    client.list.mockResolvedValue({ enabled: true, agents: [saved] });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(await client.catalog())));
    const submit = vi.fn();
    const props = { messages: [], sessionId: "chat_original" as string | undefined,
      busy: false, connected: true, conversations: [], onNewChat: vi.fn(),
      onSwitchConversation: vi.fn(), onSubmit: submit, agentClient: client, mobile };
    const view = render(<ChatApp {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: `Chat with ${saved.name}` }));
    view.rerender(<ChatApp {...props} sessionId={undefined} />);
    const input = await screen.findByRole("textbox", { name: "Message chat" });
    await waitFor(() => expect((input as HTMLTextAreaElement).disabled).toBe(false));
    fireEvent.change(input, { target: { value: "Summarize these synthetic notes" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Allow Full access/ }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(submit).toHaveBeenCalledWith("Summarize these synthetic notes", undefined,
      expect.objectContaining({ resources: [{ kind: "agent", id: saved.id, label: saved.name, revision: String(saved.revision) }] })));
  });
  it.each([false, true])("preserves the transcript and draft across recipe browsing (mobile=%s)", async (mobile) => {
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
    fireEvent.click(await screen.findByRole("button", { name: "Browse agent recipes" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message chat" })).toBeNull();
    expect(draft.isConnected).toBe(true);
    expect(await screen.findByRole("region", { name: "Agent recipes" })).toBeTruthy();
    view.rerender(<ChatApp {...props} messages={[...props.messages,
      { id: "msg_live", role: "assistant", content: "Arrived while editing", timestamp: 2000 }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Back to Chat" }));
    expect(screen.getByRole("textbox", { name: "Message chat" })).toBe(draft);
    expect((draft as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(screen.getByText("Original message")).toBeTruthy();
    expect(screen.getByText("Arrived while editing")).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });

  it("starts conversational Agent creation in a fresh Chat", async () => {
    const client = clientFixture();
    client.list.mockResolvedValue({ enabled: true, agents: [] });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(await client.catalog())));
    const onNewChat = vi.fn();
    const props = { messages: [{ id: "msg_original", role: "user" as const, content: "Original message", timestamp: 1000 }],
      sessionId: "chat_original" as string | undefined, busy: false, connected: true, conversations: [],
      onNewChat, onSwitchConversation: vi.fn(), onSubmit: vi.fn(), agentClient: client };
    const view = render(<ChatApp {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Create an agent" }));
    expect(onNewChat).toHaveBeenCalledTimes(1);
    view.rerender(<ChatApp {...props} sessionId={undefined} messages={[]} />);
    expect((await screen.findByRole("textbox", { name: "Message chat" }) as HTMLTextAreaElement).value)
      .toContain("Help me create an agent");
  });
});
