// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkRail } from "@desktop/renderer/src/features/work/WorkRail";
import { CanonicalChatIndex } from "@desktop/renderer/src/features/chat/CanonicalChatIndex";
import { RenameableConversationRow } from "../../shell/src/components/chat/ChatTitleRename";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
const items: CanonicalChatRecord[] = ["plain", "claude", "codex"].map((name) => ({
  chat: { id: `chat_${name}`, ownerScope: { type: "personal", ownerId: "owner" }, title: name, revision: 0, messageCount: 1, lifecycle: "active", attention: "none", createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" },
  ...(name === "plain" ? {} : { importSource: { harness: name as "claude" | "codex" } }),
}));
afterEach(() => { cleanup(); localStorage.clear(); useConnection.setState(useConnection.getInitialState(), true); });
describe("import origin in ordinary Chat navigation", () => {
  it.each([false, true])("keeps Web source logos before the title and unread status after it (mobile=%s)", (mobile) => {
    for (const unread of [false, true]) {
      const record = items[1]!;
      render(<RenameableConversationRow conversation={{ id: record.chat.id, title: record.chat.title, preview: "", messageCount: 1, updatedAt: 0, canonicalRecord: record,
        readState: { unread, markedUnread: unread, version: 1, readThroughSeq: 0, latestIncomingSeq: 1 } }} active={false} mobile={mobile} editing={false} renamePending={false} onSelect={vi.fn()} onRenameCommit={vi.fn()} onRenameCancel={vi.fn()}/>);
      const row = screen.getByRole("button", { name: "claude" });
      const icon = screen.getByRole("img", { name: "Imported from Claude Code" });
      expect(row.firstElementChild).toBe(icon);
      if (unread) {
        expect(row.lastElementChild).toBe(screen.getByLabelText("Unread claude"));
      } else {
        expect(screen.queryByLabelText("Unread claude")).toBeNull();
      }
      cleanup();
    }
  });
  it("keeps standalone Electron index logos aligned for read and unread Chats", () => {
    const records = items.slice(1).map((record, index) => ({ ...record,
      readState: { unread: index === 1, markedUnread: index === 1, version: 1, readThroughSeq: 0, latestIncomingSeq: 1 },
    }));
    render(<CanonicalChatIndex items={records} activeChatId={null} query="" status="ready" error={null} onQueryChange={vi.fn()} onSearch={vi.fn()} onSelect={vi.fn()} onDelete={vi.fn()} onNewChat={vi.fn()}/>);
    for (const title of ["claude", "codex"]) {
      const row = screen.getByRole("button", { name: title });
      expect(row.firstElementChild?.querySelector("img")).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "codex" }).lastElementChild).toBe(screen.getByLabelText("Unread codex"));
    expect(screen.queryByLabelText("Unread claude")).toBeNull();
  });
  it("filters actual Electron WorkRail history and shows provenance alongside existing actions", async () => {
    useConnection.setState({ status: "signed-in", userId: "owner", platformHost: "https://platform.test", runtimeSlot: "primary" });
    const client = { list: vi.fn(async () => ({ items })), agents: { list: vi.fn(async () => ({ enabled: true, agents: [] })), bots: { directBot: vi.fn(async () => null) } } } as unknown as CanonicalChatClient;
    render(<WorkRail client={client} projects={[]} active onNewGlobalChat={vi.fn()} onCreateProject={vi.fn()} onNewProjectChat={vi.fn()} onSelectChat={vi.fn()} onCollapse={vi.fn()}/>);
    await screen.findByRole("button", { name: "claude" });
    expect(screen.getByRole("img", { name: "Imported from Claude Code" })).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Chat source" }), { target: { value: "claude" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "codex" })).toBeNull());
    expect(screen.getByRole("button", { name: "claude" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "plain" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Chat source" }), { target: { value: "imported" } });
    expect(screen.getByRole("button", { name: "codex" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "plain" })).toBeNull();
  });
  it("uses identical filtering in the standalone canonical index", () => {
    render(<CanonicalChatIndex items={items} activeChatId={null} query="" status="ready" error={null} onQueryChange={vi.fn()} onSearch={vi.fn()} onSelect={vi.fn()} onDelete={vi.fn()} onNewChat={vi.fn()}/>);
    fireEvent.change(screen.getByRole("combobox", { name: "Chat source" }), { target: { value: "codex" } });
    expect(screen.getByRole("button", { name: "codex" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "claude" })).toBeNull();
    expect(screen.getByRole("img", { name: "Imported from Codex" })).toBeTruthy();
  });
  it("shows the same provenance mark in the Web Canvas and Web Desktop shared row", () => {
    const record = items[1]!;
    render(<RenameableConversationRow conversation={{ id: record.chat.id, title: record.chat.title, preview: "", messageCount: 1, updatedAt: 0, canonicalRecord: record }} active={false} mobile={false} editing={false} renamePending={false} onSelect={vi.fn()} onRenameCommit={vi.fn()} onRenameCancel={vi.fn()}/>);
    expect(screen.getByRole("img", { name: "Imported from Claude Code" })).toBeTruthy();
  });
});
