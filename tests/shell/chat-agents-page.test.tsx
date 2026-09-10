// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp.js";
import { clientFixture, saved } from "../desktop/chat-agents-fixture";

beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Web Chat Agents page", () => {
  it.each([false, true])("preserves the transcript and draft across Agent editing (mobile=%s)", async (mobile) => {
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
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Message chat" })).toBeNull();
    expect(draft.isConnected).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Meeting helper" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Description Optional" }), { target: { value: "Updated role" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText(/Saved\. Type @/);
    view.rerender(<ChatApp {...props} messages={[...props.messages,
      { id: "msg_live", role: "assistant", content: "Arrived while editing", timestamp: 2000 }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Back to Chat" }));
    expect(screen.getByRole("textbox", { name: "Message chat" })).toBe(draft);
    expect((draft as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(screen.getByText("Original message")).toBeTruthy();
    expect(screen.getByText("Arrived while editing")).toBeTruthy();
    expect(submit).not.toHaveBeenCalled();
  });
});
