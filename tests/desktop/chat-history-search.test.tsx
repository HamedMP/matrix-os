// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanonicalChatIndex } from "@desktop/renderer/src/features/chat/CanonicalChatIndex";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { canonicalChatRecord, createCanonicalChatWorkspaceClient, providerCatalog } from "./canonical-chat-workspace-test-utils";

afterEach(cleanup);
beforeEach(() => {
  globalThis.ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.operator = { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(() => () => undefined) };
});

it("shows Electron server content matches and clears search through the same adapter", () => {
  const search = vi.fn();
  render(<CanonicalChatIndex items={[canonicalChatRecord]} activeChatId={null} query="" status="ready" error={null}
    onSearch={search} onQueryChange={vi.fn()} onSelect={vi.fn()} onDelete={vi.fn()} onNewChat={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "older matching message" } });
  expect(screen.getByRole("button", { name: canonicalChatRecord.chat.title })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Search chats" }));
  expect(search).toHaveBeenCalledWith("");
});

it("keeps project voice sessions in their own history tab", async () => {
  const client = createCanonicalChatWorkspaceClient();
  const voice = { ...canonicalChatRecord, chat: { ...canonicalChatRecord.chat,
    id: "chat_project_voice", title: "Voice launch plan", conversationKind: "voice" as const } };
  vi.mocked(client.list).mockResolvedValue({ items: [canonicalChatRecord, voice] });
  render(<CanonicalChatWorkspace client={client} providerCatalog={providerCatalog} projectId="matrix-os" projectLabel="Matrix OS" active />);
  const navigation = await screen.findByRole("complementary", { name: "Project chats" });
  await waitFor(() => expect(within(navigation).getByRole("button", { name: canonicalChatRecord.chat.title })).toBeTruthy());
  expect(within(navigation).queryByRole("button", { name: "Voice launch plan" })).toBeNull();
  fireEvent.click(within(navigation).getByRole("tab", { name: /Voice conversations/ }));
  expect(within(navigation).getByRole("button", { name: "Voice launch plan" })).toBeTruthy();
  expect(within(navigation).queryByRole("button", { name: canonicalChatRecord.chat.title })).toBeNull();
});
