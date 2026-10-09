// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkRailSection } from "@desktop/renderer/src/features/work/work-rail/WorkRailSection";
import { WorkRailGroups } from "@desktop/renderer/src/features/work/work-rail/WorkRailGroups";
import { buildWorkRailModel } from "@desktop/renderer/src/features/work/work-rail-model";

afterEach(cleanup);

describe("Navigation section states", () => {
  it("shows ordinary counts only closed and keeps disclosure beside the label", () => {
    const toggle = vi.fn();
    const view = render(<WorkRailSection label="Working" count={2} expanded onToggle={toggle}>Chats</WorkRailSection>);
    const header = screen.getByRole("button", { name: "Working" });
    expect(within(header).queryByText("2")).toBeNull();
    const label = within(header).getByText("Working");
    expect(label.nextElementSibling?.classList.contains("work-rail-section-disclosure")).toBe(true);
    view.rerender(<WorkRailSection label="Working" count={2} expanded={false} onToggle={toggle}>Chats</WorkRailSection>);
    expect(within(screen.getByRole("button", { name: "Working" })).getByText("2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Working" }));
    expect(toggle).toHaveBeenCalledOnce();
  });

  it("keeps uppercase Projects creation in its header and quiet empty attention headings", () => {
    const create = vi.fn();
    render(<WorkRailGroups model={buildWorkRailModel([], [])} sections={{ pinned: true, projects: false, needsYou: true, working: true, done: false }} onToggle={vi.fn()} onCreateProject={create} renderProject={() => null} renderChat={() => null} bots={[]} sharedProjects={[]} organizationDrives={null} />);
    expect(screen.queryByRole("button", { name: "Pinned" })).toBeNull();
    expect(screen.getByRole("button", { name: "Working" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Needs you" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
    const projects = screen.getByRole("button", { name: "Projects" });
    expect(projects.querySelector(".work-rail-section-icon")).toBeNull();
    expect(projects.closest(".work-rail-group-heading")).toBeNull();
    const createButton = screen.getByRole("button", { name: "Create project" });
    expect(createButton.closest('[data-slot="chat-sidebar-section-heading"]')).toBeTruthy();
    expect(screen.queryByText("New project")).toBeNull();
    fireEvent.click(createButton);
    expect(create).toHaveBeenCalledOnce();
  });
});

import { WorkRailChatRow } from "@desktop/renderer/src/features/work/work-rail/WorkRailChatRow";
import { WorkRailSearchControls } from "@desktop/renderer/src/features/work/work-rail/WorkRailHeader";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
const menuChat = { chat: { id: "chat_test", title: "Long Chat title", ownerScope: { type: "personal", ownerId: "owner" }, attention: "none", lifecycle: "active", revision: 1, messageCount: 0, createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z" } } as CanonicalChatRecord;

it("opens supported actions from row ellipsis and keeps Delete separated and confirmed by host", async () => {
  const remove = vi.fn();
  render(<WorkRailChatRow record={menuChat} active pinning={false} placement="pinned" onSelect={vi.fn()} renaming={false} renamePending={false} renameDisabled={false} onRenameStart={vi.fn()} onRenameCommit={vi.fn()} onRenameCancel={vi.fn()} onPin={vi.fn()} onDelete={remove} />);
  expect(screen.queryByRole("button", { name: "Delete Long Chat title" })).toBeNull();
  const menu = screen.getByRole("button", { name: "Actions for Long Chat title" });
  fireEvent.pointerDown(menu, { button: 0, ctrlKey: false });
  const deleteItem = await screen.findByRole("menuitem", { name: "Delete" });
  expect(deleteItem.previousElementSibling?.getAttribute("role")).toBe("separator");
  expect(screen.getAllByRole("menuitem").map(item => item.textContent)).toEqual(["Pin", "Rename", "Delete"]);
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(deleteItem);
  expect(remove).toHaveBeenCalledOnce();
});
it("marks Search Current only while open", () => {
  const view = render(<WorkRailSearchControls onSearch={vi.fn()} active={false} />);
  expect(screen.getByRole("button", { name: "Search chats" }).getAttribute("aria-current")).toBeNull();
  view.rerender(<WorkRailSearchControls onSearch={vi.fn()} active />);
  expect(screen.getByRole("button", { name: "Search chats" }).getAttribute("aria-current")).toBe("page");
});

import { WorkRail } from "@desktop/renderer/src/features/work/WorkRail";
import { renderRailFixture } from "./work-rail-client-fixture";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
it("keeps Search fixed and Pinned above Projects while Done starts expanded and supports explicit collapse", async () => {
  const pinned = { ...menuChat, chat: { ...menuChat.chat, id: "chat_pinned", title: "Pinned item", userState: { pinned: true, muted: false, readThroughSeq: 0 } } } as CanonicalChatRecord;
  const client = { list: vi.fn(async () => ({ items: [pinned, menuChat] })) } as unknown as CanonicalChatClient;
  renderRailFixture(<WorkRail client={client} projects={[{ id: "project", slug: "alpha", name: "Alpha", kind: "folder" }]} active activeProjectSlug="alpha" onNewGlobalChat={vi.fn()} onCreateProject={vi.fn()} onNewProjectChat={vi.fn()} onSelectChat={vi.fn()} onCollapse={vi.fn()} />);
  await screen.findByRole("button", { name: "Pinned item" });
  const scroll = screen.getByTestId("work-rail-scroll");
  expect(scroll.contains(screen.getByRole("button", { name: "Search chats" }))).toBe(false);
  expect([...scroll.querySelectorAll('[data-slot="chat-sidebar-section-heading"]')].map(header => header.querySelector("button")?.getAttribute("aria-label"))).toEqual(["Pinned", "Projects", "Needs you", "Working", "Done"]);
  expect(screen.getByRole("button", { name: menuChat.chat.title })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.queryByRole("button", { name: menuChat.chat.title })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByRole("button", { name: menuChat.chat.title })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Alpha" }).closest(".work-rail-project")?.getAttribute("data-current")).toBe("true");
  const label = screen.getByRole("button", { name: "Alpha" });
  expect(label.getAttribute("title")).toBe("Alpha");
  expect(label.nextElementSibling?.getAttribute("aria-label")).toBe("Expand Alpha chats");
});
