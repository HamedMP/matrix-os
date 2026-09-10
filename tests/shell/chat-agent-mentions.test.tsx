// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp.js";
import { CanonicalChatRequestIdSchema } from "../../packages/contracts/src/index";
import { createCanonicalProviderCatalogFixture } from "../contracts/fixtures/canonical-chat";
import type { ChatAgentClient } from "../../packages/ui/src/chat-agents/client";
const agent = { kind: "agent" as const, id: "bot_meeting01", label: "Meeting helper" };
const source = { kind: "chat" as const, id: "chat_notes", label: "Meeting notes" };
let client: ChatAgentClient;
beforeEach(() => {
  window.localStorage.clear();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(createCanonicalProviderCatalogFixture())));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  client = {
    list: vi.fn(async () => ({ enabled: true, agents: [] })),
    search: vi.fn(async () => ({ enabled: true, resources: [agent, source] })),
    catalog: vi.fn(), create: vi.fn(), update: vi.fn(), preview: vi.fn(),
  };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const base = {
  messages: [{ id: "msg_original", role: "user" as const, content: "Original Chat text", timestamp: 1000 }],
  sessionId: "chat_original", busy: false, connected: true, conversations: [],
  onNewChat: vi.fn(), onSwitchConversation: vi.fn(),
};
it("uses the existing Web Chat input with typed mentions and preserves rejected drafts", async () => {
  const submit = vi.fn(async () => false);
  render(<ChatApp {...base} onSubmit={submit} agentClient={client} />);
  await waitFor(() => expect((screen.getByRole("textbox", { name: "Message chat" }) as HTMLTextAreaElement).disabled).toBe(false));
  const editor = screen.getByRole("textbox", { name: "Message chat" });
  fireEvent.change(editor, { target: { value: "@mee" } });
  fireEvent.click(await screen.findByRole("option", { name: /Meeting helper/ }));
  expect(submit).not.toHaveBeenCalled();
  fireEvent.change(editor, { target: { value: "Prepare the meeting" } });
  fireEvent.click(screen.getByRole("checkbox", { name: /Allow Full access/ }));
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(submit).toHaveBeenCalled());
  expect(submit.mock.calls[0]![2]).toMatchObject({ resources: [agent], permissionMode: "full_access", instanceId: "codex_fixture" });
  expect(CanonicalChatRequestIdSchema.safeParse(submit.mock.calls[0]![2]?.clientRequestId).success).toBe(true);
  expect((editor as HTMLTextAreaElement).value).toBe("Prepare the meeting");
  expect(screen.getByText("Original Chat text")).toBeTruthy();
});
it("preserves text and selected references across Chat switches", async () => {
  const submit = vi.fn(async () => true);
  const { rerender } = render(<ChatApp {...base} onSubmit={submit} agentClient={client} />);
  await waitFor(() => expect((screen.getByRole("textbox", { name: "Message chat" }) as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(screen.getByRole("textbox", { name: "Message chat" }), { target: { value: "@mee" } });
  fireEvent.click(await screen.findByRole("option", { name: /Meeting notes/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Message chat" }), { target: { value: "Keep this draft" } });
  rerender(<ChatApp {...base} sessionId="chat_other" onSubmit={submit} agentClient={client} />);
  expect((screen.getByRole("textbox", { name: "Message chat" }) as HTMLTextAreaElement).value).toBe("");
  expect(screen.queryByRole("button", { name: "Remove Meeting notes" })).toBeNull();
  rerender(<ChatApp {...base} onSubmit={submit} agentClient={client} />);
  expect((screen.getByRole("textbox", { name: "Message chat" }) as HTMLTextAreaElement).value).toBe("Keep this draft");
  expect(screen.getByRole("button", { name: "Remove Meeting notes" })).toBeTruthy();
});
it("queues a referenced request while the current Chat is busy", async () => {
  const submit = vi.fn(async () => true);
  render(<ChatApp {...base} busy onSubmit={submit} agentClient={client} />);
  await waitFor(() => expect((screen.getByRole("textbox", { name: "Message chat" }) as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(screen.getByRole("textbox", { name: "Message chat" }), { target: { value: "@mee" } });
  fireEvent.click(await screen.findByRole("option", { name: /Meeting notes/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Message chat" }), { target: { value: "Continue with these notes" } });
  fireEvent.click(screen.getByRole("button", { name: "Queue next" }));
  await waitFor(() => expect(submit).toHaveBeenCalled());
  expect(submit.mock.calls[0]![2]).toMatchObject({ resources: [source] });
});
it("keeps a queued request visible when cancellation fails", async () => {
  const cancel = vi.fn(async () => false);
  render(<ChatApp {...base} onSubmit={vi.fn()} agentClient={client} queuedTurns={[{
    id: "cqturn_notes", chatId: base.sessionId, clientRequestId: "req_notes", position: 1,
    parts: [{ type: "text", text: "Use the meeting notes" }], selection: { instanceId: "codex_fixture", model: "gpt-5.6-sol" },
    interactionMode: "default", permissionMode: "full_access", createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z",
  }]} onCancelQueuedTurn={cancel} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel queued request" }));
  await screen.findByText("Queued request could not be cancelled. Try again.");
  expect(screen.getByText("Use the meeting notes")).toBeTruthy();
});
it("does not show the new picker when the feature switch is off", async () => {
  vi.mocked(client.list).mockResolvedValue({ enabled: false, agents: [] });
  vi.mocked(client.search).mockResolvedValue({ enabled: false, resources: [] });
  render(<ChatApp {...base} onSubmit={vi.fn()} agentClient={client} />);
  await waitFor(() => expect((screen.getByRole("textbox", { name: "Message chat" }) as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(screen.getByRole("textbox", { name: "Message chat" }), { target: { value: "@mee" } });
  await waitFor(() => expect(client.search).toHaveBeenCalled());
  expect(screen.queryByRole("listbox", { name: "Agents and Chat context" })).toBeNull();
});
it("supports choosing a reference from the keyboard", async () => {
  render(<ChatApp {...base} onSubmit={vi.fn()} agentClient={client} />);
  const editor = screen.getByRole("textbox", { name: "Message chat" });
  await waitFor(() => expect((editor as HTMLTextAreaElement).disabled).toBe(false));
  fireEvent.change(editor, { target: { value: "@mee" } });
  const option = await screen.findByRole("option", { name: /Meeting helper/ });
  fireEvent.keyDown(editor, { key: "ArrowDown" });
  expect(document.activeElement).toBe(option);
  fireEvent.click(option);
  expect(document.activeElement).toBe(editor);
});
