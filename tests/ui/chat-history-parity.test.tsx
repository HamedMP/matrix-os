// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatHistory } from "../../packages/ui/src/chat/ChatHistory.js";
afterEach(() => { cleanup(); vi.useRealTimers(); });
const items = [
  { id: "chat_task", title: "Launch website", updatedAt: 1, unread: false, conversationKind: "chat" as const },
  { id: "chat_voice", title: "Plan my week", updatedAt: 2, unread: true, conversationKind: "voice" as const },
];
describe("shared Chat history presentation", () => {
  it("retains server content matches outside the title and latest preview", () => {
    render(<ChatHistory items={items} searchMode="remote" onSelect={vi.fn()} onNewChat={vi.fn()} onQueryChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "older message contents" } });
    expect(screen.getByRole("button", { name: "Launch website" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Plan my week" })).toBeNull();
  });
  it("clears the filter when search is hidden", () => {
    render(<ChatHistory items={items} onSelect={vi.fn()} onNewChat={vi.fn()} />);
    const search = screen.getByRole("button", { name: "Search chats" });
    fireEvent.click(search);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "absent" } });
    expect(screen.queryByRole("button", { name: "Launch website" })).toBeNull();
    fireEvent.click(search);
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Launch website" })).toBeTruthy();
  });
  it("debounces remote searches and cancels stale work on close or unmount", async () => {
    vi.useFakeTimers();
    const change = vi.fn();
    const view = render(<ChatHistory items={items} searchMode="remote" onSelect={vi.fn()} onNewChat={vi.fn()} onQueryChange={change} />);
    const search = screen.getByRole("button", { name: "Search chats" });
    fireEvent.click(search);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "l" } });
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "launch" } });
    expect(change).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(change.mock.calls).toEqual([["launch"]]);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "stale" } });
    fireEvent.click(search);
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(change.mock.calls).toEqual([["launch"], [""]]);
    fireEvent.click(search);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "unmounted" } });
    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(change).toHaveBeenCalledTimes(2);
  });
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
