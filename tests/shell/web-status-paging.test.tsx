// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { usePagedStatusGroup } from "../../shell/src/components/chat/usePagedStatusGroup";
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { WebChatLifecycleGroups } from "../../shell/src/components/chat/WebChatLifecycleGroups";

afterEach(cleanup);

it("retains expanded status rows across a navigation refresh", async () => {
  const item = (index: number) => ({ chat: { id: `chat_${index}`, title: `Chat ${index}`, messageCount: 0,
    updatedAt: "2026-11-12T00:00:00.000Z" } });
  const loadPage = vi.fn(async (input: { cursor?: string }) => input.cursor
    ? { items: Array.from({ length: 20 }, (_, index) => item(index + 10)), totalCount: 30 }
    : { items: Array.from({ length: 10 }, (_, index) => item(index)), totalCount: 30, nextCursor: "next" });
  const hook = renderHook(({ version }) => usePagedStatusGroup("done", loadPage as never, "owner/main", version), { initialProps: { version: 0 } });
  await waitFor(() => expect(hook.result.current.rows).toHaveLength(10));
  act(() => hook.result.current.loadMore());
  await waitFor(() => expect(hook.result.current.rows).toHaveLength(30));
  hook.rerender({ version: 1 });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(hook.result.current.rows).toHaveLength(30);
});

it("applies the selected source to server-paged status rows", async () => {
  const loadPage = vi.fn(async () => ({ items: [
    { chat: { id: "chat_claude", title: "Claude chat", messageCount: 0, updatedAt: "2026-11-12T00:00:00.000Z" }, importSource: { harness: "claude" } },
    { chat: { id: "chat_codex", title: "Codex chat", messageCount: 0, updatedAt: "2026-11-12T00:00:00.000Z" }, importSource: { harness: "codex" } },
  ], totalCount: 2 }));
  render(<WebChatLifecycleGroups conversations={[]} loadPage={loadPage as never} sourceFilter="claude" renderRow={row => <div>{row.title}</div>} />);
  expect((await screen.findAllByText("Claude chat")).length).toBeGreaterThan(0);
  expect(screen.queryByText("Codex chat")).toBeNull();
});

it("keeps read chats out of mobile Unread after status pages load", async () => {
  const loadPage = vi.fn(async () => ({ items: [
    { chat: { id: "chat_read", title: "Read chat", messageCount: 4, updatedAt: "2026-11-12T00:00:00.000Z" }, readState: { unread: false } },
    { chat: { id: "chat_unread", title: "Unread chat", messageCount: 4, updatedAt: "2026-11-12T00:00:00.000Z" }, readState: { unread: true } },
  ], totalCount: 2 }));
  render(<WebChatLifecycleGroups conversations={[]} loadPage={loadPage as never} unreadOnly renderRow={row => <div>{row.title}</div>} />);
  expect((await screen.findAllByText("Unread chat")).length).toBeGreaterThan(0);
  expect(screen.queryByText("Read chat")).toBeNull();
});

it("keeps Pinned and Show more available when unread pinned chats are on a later page", async () => {
  const loadPage = vi.fn(async (input: { group: string; cursor?: string }) => input.group !== "pinned"
    ? { items: [], totalCount: 0 }
    : input.cursor
      ? { items: [{ chat: { id: "chat_later", title: "Later unread pinned chat", messageCount: 1,
        updatedAt: "2026-11-12T00:00:00.000Z" }, readState: { unread: true } }], totalCount: 11 }
      : { items: Array.from({ length: 10 }, (_, index) => ({ chat: { id: `chat_read_${index}`, title: `Read ${index}`,
        messageCount: 1, updatedAt: "2026-11-12T00:00:00.000Z" }, readState: { unread: false } })),
        totalCount: 11, nextCursor: "next" });
  render(<WebChatLifecycleGroups conversations={[]} loadPage={loadPage as never} unreadOnly
    renderRow={row => <div>{row.title}</div>} />);
  const more = await screen.findByRole("button", { name: "Show more Pinned chats" });
  fireEvent.click(more);
  expect(await screen.findByText("Later unread pinned chat")).toBeTruthy();
});
