// @vitest-environment jsdom
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatImportSourceFilter, ChatImportSourceIcon } from "../../packages/ui/src/chat/ChatImportSource.js";
import { filterChatsByImportSource } from "../../packages/ui/src/chat/import-source.js";
import { CanonicalChatRecordSchema } from "@matrix-os/contracts";
import { mergeChatNavigationRecord, projectDetailNavigation } from "../../packages/ui/src/chat-navigation/projection.js";
afterEach(cleanup);
const items = [{ title: "Normal", source: undefined }, { title: "Claude", source: { harness: "claude" as const } }, { title: "Codex", source: { harness: "codex" as const } }];
describe("shared Chat import source", () => {
  it("filters all/imported/Claude Code/Codex from provenance only and preserves order", () => {
    const source = (item: typeof items[number]) => item.source;
    expect(filterChatsByImportSource(items, "all", source)).toEqual(items);
    expect(filterChatsByImportSource(items, "imported", source)).toEqual(items.slice(1));
    expect(filterChatsByImportSource(items, "claude", source).map(i => i.title)).toEqual(["Claude"]);
    expect(filterChatsByImportSource(items, "codex", source).map(i => i.title)).toEqual(["Codex"]);
    expect(filterChatsByImportSource(items.filter(i => i.title.includes("Claude")), "codex", source)).toEqual([]);
  });
  it("shows accessible monochrome source icons and shared filter labels", () => {
    function Demo() { const [value, setValue] = useState<"all" | "imported" | "claude" | "codex">("all"); return <ChatImportSourceFilter value={value} onChange={setValue}/>; }
    const view = render(<><ChatImportSourceIcon harness="claude"/><ChatImportSourceIcon harness="codex" size={18}/><Demo/></>);
    expect(screen.getByRole("img", { name: "Imported from Claude Code" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "Imported from Codex" })).toBeTruthy();
    expect(view.container.querySelector('svg[width="18"]')).toBeTruthy();
    const select = screen.getByRole("combobox", { name: "Chat source" });
    expect(screen.getAllByRole("option").map(o => o.textContent)).toEqual(["All", "Imported", "Claude Code", "Codex"]);
    fireEvent.change(select, { target: { value: "codex" } }); expect((select as HTMLSelectElement).value).toBe("codex");
  });
  it("strictly validates optional provenance and preserves it across provider updates and navigation projections", () => {
    const chat = { id: "chat_source", ownerScope: { type: "personal", ownerId: "owner" }, title: "History", revision: 0, messageCount: 0, lifecycle: "active", attention: "none", createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" };
    const record = CanonicalChatRecordSchema.parse({ chat, importSource: { harness: "claude" } });
    expect(CanonicalChatRecordSchema.safeParse({ chat, importSource: { harness: "hermes" } }).success).toBe(false);
    expect(CanonicalChatRecordSchema.safeParse({ chat, importSource: { harness: "claude", path: "/secret" } }).success).toBe(false);
    const current = { ...record, readState: { unread: false, markedUnread: false, version: 0, readThroughSeq: 0, latestIncomingSeq: 0 }, classification: { kind: "ordinary" as const }, persistence: "personal" as const };
    expect(projectDetailNavigation(record, current).importSource).toEqual({ harness: "claude" });
    expect(mergeChatNavigationRecord(current, { ...current, providerBinding: { driverKind: "codex" } }).importSource).toEqual({ harness: "claude" });
  });
});
