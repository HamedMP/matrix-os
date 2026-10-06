// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatHistory } from "../../packages/ui/src/chat/ChatHistory.js";
afterEach(cleanup);
const items = [
  { id: "chat_task", title: "Launch website", updatedAt: 1, unread: false, conversationKind: "chat" as const },
  { id: "chat_voice", title: "Plan my week", updatedAt: 2, unread: true, conversationKind: "voice" as const },
];
describe("shared Chat history presentation", () => {
  it("keeps voice sessions out of ordinary recents", () => {
    const select = vi.fn();
    render(<ChatHistory items={items} onSelect={select} onNewChat={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Launch website" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Plan my week" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Voice conversations/ }));
    expect(screen.queryByRole("button", { name: "Launch website" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Plan my week" }));
    expect(select).toHaveBeenCalledWith("chat_voice");
  });
  it("shows a selected voice conversation in its own tab and searches that tab only", () => {
    render(<ChatHistory items={items} activeChatId="chat_voice" onSelect={vi.fn()} onNewChat={vi.fn()} />);
    expect(screen.getByRole("tab", { name: /Voice conversations/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Launch" } });
    expect(screen.queryByRole("button", { name: "Launch website" })).toBeNull();
    expect(screen.getByText("No matching conversations.")).toBeTruthy();
  });
  it("supports keyboard tab selection and unread filtering", () => {
    render(<ChatHistory items={items} onSelect={vi.fn()} onNewChat={vi.fn()} />);
    const chat = screen.getByRole("tab", { name: "Chats" }); chat.focus();
    fireEvent.keyDown(chat, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /Voice conversations/ })).toBe(document.activeElement);
    expect(screen.getByRole("button", { name: "Plan my week" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unread" }));
    expect(screen.getByRole("button", { name: "Plan my week" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Chats" }));
    expect(screen.queryByRole("button", { name: "Launch website" })).toBeNull();
  });
  it("preserves a failed rename draft and reports a safe error", async () => {
    const rename = vi.fn(async () => false);
    render(<ChatHistory items={items} onSelect={vi.fn()} onNewChat={vi.fn()} onRename={rename} />);
    fireEvent.click(screen.getByRole("button", { name: "Options for Launch website" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename Launch website" });
    fireEvent.change(input, { target: { value: "Launch plan" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(rename).toHaveBeenCalledWith("chat_task", "Launch plan"));
    expect(screen.getByRole("alert").textContent).toBe("Title could not be saved. Try again.");
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("Launch plan");
  });
});
