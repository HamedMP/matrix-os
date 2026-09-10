// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMentionControls, useChatMentionPermission } from "../../packages/ui/src/chat-agents/ChatMentionControls.js";
import { canAddChatMention, chatAgentAttribution, orderChatResources } from "../../packages/ui/src/chat-agents/mentions.js";
import type { ChatAgentClient } from "../../packages/ui/src/chat-agents/client.js";
const bot = { kind: "agent" as const, id: "bot_meeting01", label: "Meeting helper" };
const chat = { kind: "chat" as const, id: "chat_notes", label: "Meeting notes" };
const file = { kind: "file" as const, id: "file_notes", label: "notes.md" };
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);
it("keeps one Agent and three distinct Chats while preserving other resources", () => {
  expect(canAddChatMention([bot], { ...bot, id: "bot_other001" })).toBe(false);
  expect(canAddChatMention([bot], file)).toBe(true);
  expect(canAddChatMention([chat, { ...chat, id: "chat_second" }, { ...chat, id: "chat_third" }], { ...chat, id: "chat_fourth" })).toBe(false);
  expect(orderChatResources([file, chat, bot])).toEqual([bot, chat, file]);
});
it("requires explicit per-request access and resets it on Chat changes and after removal", () => {
  const { result, rerender } = renderHook(({ scope, resources }) => useChatMentionPermission(scope, resources, "supervised"), {
    initialProps: { scope: "chat_one", resources: [bot] },
  });
  expect(result.current.allowed).toBe(false);
  act(() => result.current.confirm(true));
  expect(result.current.allowed).toBe(true);
  expect(result.current.permissionMode).toBe("full_access");
  rerender({ scope: "chat_two", resources: [bot] });
  expect(result.current.allowed).toBe(false);
  act(() => result.current.confirm(true));
  rerender({ scope: "chat_two", resources: [] });
  expect(result.current.permissionMode).toBe("supervised");
  rerender({ scope: "chat_two", resources: [bot] });
  expect(result.current.allowed).toBe(false);
});
it("previews bounded Chat context with provenance without starting work", async () => {
  const client = { preview: vi.fn(async () => ({ chatId: chat.id, title: chat.label, throughSeq: 28, text: "Decisions: meet on Thursday.", truncated: true })) } as unknown as ChatAgentClient;
  render(<ChatMentionControls client={client} resources={[chat]} permissionMode="supervised" confirmed={false} onConfirm={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview Meeting notes" }));
  expect(await screen.findByText("Decisions: meet on Thursday.")).toBeTruthy();
  expect(screen.getByText(/through message 28/i)).toBeTruthy();
  expect(screen.getByText(/limited/i)).toBeTruthy();
  expect(client.preview).toHaveBeenCalledWith(chat.id);
});
it("does not display raw preview errors", async () => {
  const client = { preview: vi.fn(async () => { throw new Error("/opt/private postgres secret"); }) } as unknown as ChatAgentClient;
  render(<ChatMentionControls client={client} resources={[chat]} permissionMode="supervised" confirmed={false} onConfirm={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview Meeting notes" }));
  expect((await screen.findByRole("alert")).textContent).not.toMatch(/private|postgres|secret/);
});
