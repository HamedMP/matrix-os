// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatNavigationRecord } from "@matrix-os/ui";
import { WorkRailProjectGroup } from "@desktop/renderer/src/features/work/work-rail/WorkRailProjectGroup";
import { compactChatStartLabel } from "@matrix-os/ui";

const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const alpha = { id: "proj_alpha", slug: "alpha", name: "Alpha", kind: "folder" as const };

function chat(index: number): ChatNavigationRecord {
  const createdAt = new Date(NOW - index * 60 * 60 * 1000).toISOString();
  return {
    chat: {
      id: `chat_${index}`, ownerScope: { type: "personal", ownerId: "owner_test" }, title: `Chat ${index}`,
      lifecycle: "active", attention: "none", revision: 1, messageCount: 1,
      userState: { readThroughSeq: 0, pinned: false, muted: false }, createdAt, updatedAt: createdAt,
    },
    projectId: alpha.id,
  } as unknown as ChatNavigationRecord;
}

function renderGroup(count: number, activeChatId?: string) {
  render(<WorkRailProjectGroup group={{ id: alpha.id, slug: alpha.slug, name: alpha.name, project: alpha, chats: Array.from({ length: count }, (_, index) => chat(index + 1)) }}
    expanded activeChatId={activeChatId} pinning={{}} onToggle={vi.fn()} onNewChat={vi.fn()} onDeleteProject={vi.fn()}
    onSelectChat={vi.fn()} renamingChatId={null} renamePending={false} onRenameChat={vi.fn()}
    onRenameCommit={vi.fn()} onRenameCancel={vi.fn()} onPinChat={vi.fn()} onDeleteChat={vi.fn()} />);
}

const visibleChats = () => screen.queryAllByRole("button", { name: /^Chat \d+$/ }).map((button) => button.getAttribute("aria-label"));

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("shows project Chats six at a time with Show more", () => {
  renderGroup(14);
  expect(visibleChats()).toEqual(["Chat 1", "Chat 2", "Chat 3", "Chat 4", "Chat 5", "Chat 6"]);

  fireEvent.click(screen.getByRole("button", { name: "Show more Alpha chats" }));
  expect(visibleChats()).toHaveLength(12);

  fireEvent.click(screen.getByRole("button", { name: "Show more Alpha chats" }));
  expect(visibleChats()).toHaveLength(14);
  expect(screen.queryByRole("button", { name: "Show more Alpha chats" })).toBeNull();
});

it("has no Show more control for six or fewer Chats", () => {
  renderGroup(6);
  expect(visibleChats()).toHaveLength(6);
  expect(screen.queryByRole("button", { name: "Show more Alpha chats" })).toBeNull();
});

it("keeps the open Chat visible even when it is past the first six", () => {
  renderGroup(10, "chat_9");
  expect(visibleChats()).toContain("Chat 9");
  expect(screen.getByRole("button", { name: "Show more Alpha chats" })).toBeTruthy();
});

it("shows when each project Chat started", () => {
  renderGroup(2);
  const row = screen.getByRole("button", { name: "Chat 2" });
  const started = within(row).getByText("2h");
  expect(started.tagName).toBe("TIME");
  expect(started.getAttribute("dateTime")).toBe(new Date(NOW - 2 * 60 * 60 * 1000).toISOString());
  expect(started.getAttribute("title")).toMatch(/^Started /);
});

it("formats compact start labels", () => {
  expect(compactChatStartLabel(new Date(NOW - 20_000).toISOString(), NOW)).toBe("now");
  expect(compactChatStartLabel(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5m");
  expect(compactChatStartLabel(new Date(NOW - 3 * 60 * 60_000).toISOString(), NOW)).toBe("3h");
  expect(compactChatStartLabel(new Date(NOW - 2 * 24 * 60 * 60_000).toISOString(), NOW)).toBe("2d");
  expect(compactChatStartLabel("not a date", NOW)).toBe("");
});

it("hands focused Project rows their original records so row actions keep the Project", async () => {
  const { FocusedProjectRail } = await import("@desktop/renderer/src/features/work/work-rail/FocusedProjectRail");
  const records = [chat(1), chat(2)];
  const renderChat = vi.fn((record: ChatNavigationRecord) => <div key={record.chat.id}>{record.chat.title}</div>);
  render(<FocusedProjectRail group={{ id: alpha.id, slug: alpha.slug, name: alpha.name, project: alpha, chats: records }} records={records}
    sections={{ pinned: true, projects: true, needsYou: true, working: true, done: true }} onToggle={vi.fn()}
    renderChat={renderChat} onBack={vi.fn()} onNewChat={vi.fn()} />);
  expect(renderChat).toHaveBeenCalledTimes(2);
  for (const [record] of renderChat.mock.calls) expect(records).toContain(record);
});

it("refreshes Chat start ages when a long-collapsed Project expands", () => {
  const group = { id: alpha.id, slug: alpha.slug, name: alpha.name, project: alpha, chats: [chat(1)] };
  const props = { group, pinning: {}, onToggle: vi.fn(), onNewChat: vi.fn(), onDeleteProject: vi.fn(), onSelectChat: vi.fn(),
    renamingChatId: null, renamePending: false, onRenameChat: vi.fn(), onRenameCommit: vi.fn(), onRenameCancel: vi.fn(),
    onPinChat: vi.fn(), onDeleteChat: vi.fn() };
  const { rerender } = render(<WorkRailProjectGroup {...props} expanded={false} />);
  vi.setSystemTime(NOW + 3 * 60 * 60 * 1000);
  rerender(<WorkRailProjectGroup {...props} expanded />);
  expect(within(screen.getByRole("button", { name: "Chat 1" })).getByText("4h")).toBeTruthy();
});
