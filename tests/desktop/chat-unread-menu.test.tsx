// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { WorkRail } from "../../desktop/src/renderer/src/features/work/WorkRail.js";
import type { CanonicalChatClient } from "../../desktop/src/renderer/src/lib/canonical-chat-client.js";
import { RenameableConversationRow } from "../../shell/src/components/chat/ChatTitleRename.js";
import { mergeChatReadState } from "../../packages/ui/src/chat/read-state.js";

afterEach(cleanup);
const record: CanonicalChatRecord = {
  chat: {
    id: "chat_menu", ownerScope: { type: "personal", ownerId: "owner" }, title: "My chat",
    lifecycle: "active", attention: "none", revision: 1, messageCount: 0,
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
  },
  readState: { unread: false, markedUnread: false, version: 0, readThroughSeq: 0, latestIncomingSeq: 0 },
};

it("places the action first in Electron and persists it without opening the chat", async () => {
  const marked = { ...record, readState: { ...record.readState!, unread: true, markedUnread: true, version: 1 } };
  const client = { list: vi.fn(async () => ({ items: [record] })), updateReadState: vi.fn(async () => marked) };
  const onSelectChat = vi.fn();
  render(<WorkRail client={client as unknown as CanonicalChatClient} projects={[]} active
    onNewGlobalChat={vi.fn()} onCreateProject={vi.fn()} onNewProjectChat={vi.fn()}
    onSelectChat={onSelectChat} onCollapse={vi.fn()} />);
  fireEvent.contextMenu(await screen.findByRole("button", { name: "My chat" }));
  expect(screen.getAllByRole("menuitem")[0].textContent).toBe("Mark as unread");
  expect(screen.getAllByRole("menuitem").findIndex((item) => item.textContent === "Rename")).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("menuitem", { name: "Mark as unread" }));
  await waitFor(() => expect(client.updateReadState).toHaveBeenCalledWith("chat_menu", { type: "mark_unread" }));
  expect(onSelectChat).not.toHaveBeenCalled();
  await screen.findByLabelText("Unread My chat");
  fireEvent.contextMenu(screen.getByRole("button", { name: "My chat" }));
  expect(screen.getAllByRole("menuitem")[0].textContent).toBe("Mark as read");
});

it.each([false, true])("places the action before Rename in the web menu (unread=%s)", (unread) => {
  const onToggleRead = vi.fn();
  const onSelect = vi.fn();
  render(<RenameableConversationRow conversation={{ id: "chat_menu", title: "My chat", preview: "", messageCount: 0, updatedAt: 0,
    readState: { ...record.readState!, unread } }} active={false} mobile={false} editing={false} renamePending={false}
    onSelect={onSelect} onToggleRead={onToggleRead} onRenameStart={vi.fn()} onRenameCommit={vi.fn()} onRenameCancel={vi.fn()} />);
  fireEvent.contextMenu(screen.getByRole("button", { name: "My chat" }));
  const first = screen.getAllByRole("menuitem")[0];
  expect(first.textContent).toBe(unread ? "Mark as read" : "Mark as unread");
  expect(screen.getAllByRole("menuitem").findIndex((item) => item.textContent === "Rename")).toBeGreaterThan(0);
  fireEvent.click(first);
  expect(onToggleRead).toHaveBeenCalledTimes(1);
  expect(onSelect).not.toHaveBeenCalled();
});

it("merges read acknowledgements without losing newer replies, titles, or manual choices", () => {
  const newer = { ...record, chat: { ...record.chat, title: "New title", revision: 3 },
    readState: { ...record.readState!, unread: true, latestIncomingSeq: 4 } };
  const response = { ...record, readState: { ...record.readState!, version: 1, readThroughSeq: 2 } };
  const merged = mergeChatReadState(newer, response);
  expect(merged.chat).toEqual(newer.chat);
  expect(merged.readState).toMatchObject({ unread: true, latestIncomingSeq: 4, readThroughSeq: 2 });
  expect(mergeChatReadState(merged, record)).toBe(merged);
});
