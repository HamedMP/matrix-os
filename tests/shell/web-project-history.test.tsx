// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_HISTORY_REFRESH_DELAY_MS, useWebProjectHistory } from "../../shell/src/components/chat/useWebProjectHistory";
import { isChatMembershipEvent } from "../../shell/src/hooks/useCanonicalChatState";

const project = { id: "proj_a", slug: "proj_a", name: "Alpha" };
const record = (id: string) => ({
  chat: { id, ownerScope: { type: "personal", ownerId: "owner" }, title: id, lifecycle: "active", attention: "none", revision: 1, messageCount: 1,
    createdAt: "2026-01-10T10:00:00.000Z", updatedAt: "2026-01-10T10:00:00.000Z" },
  projectId: "proj_a",
});
const PAGE_MS = 300;

/** Two-page history; each page answers after PAGE_MS. Counts pages and full reads. */
function installPagedFetch() {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url.searchParams.get("cursor") ?? "first");
    const body = url.searchParams.get("cursor")
      ? { items: [record("chat_page2")] }
      : { items: [record("chat_page1")], nextCursor: "chatcur_next" };
    return new Promise<Response>((resolve) => setTimeout(() => resolve(new Response(JSON.stringify(body), { status: 200 })), PAGE_MS));
  }));
  return { calls, reads: () => calls.filter((cursor) => cursor === "first").length };
}

const listed: never[] = [];
const botClient = { list: vi.fn(async () => ({ enabled: true, agents: [] })),
  bots: { directBot: vi.fn(async () => null), tasks: vi.fn(async () => []), interactions: vi.fn(async () => []) } } as never;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("web project history refresh", () => {
  it("finishes a paged read during constant Chat changes and then refreshes once", async () => {
    const fetches = installPagedFetch();
    let refreshKey = 0;
    const view = renderHook(() => useWebProjectHistory({ project, gatewayUrl: "https://example.test", listed, refreshKey, enabled: true, botClient }));
    // Chat changes every 100 ms while both pages of the first read are in flight.
    for (let tick = 0; tick < 6; tick += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      refreshKey += 1;
      view.rerender();
    }
    // The first read was not cancelled: both of its pages were fetched and it landed.
    expect(fetches.calls.slice(0, 2)).toEqual(["first", "chatcur_next"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(view.result.current.loading).toBe(false);
    expect(view.result.current.records.map((item) => item.chat.id).sort()).toEqual(["chat_page1", "chat_page2"]);
    // Every change during the read collapsed into one trailing read.
    expect(fetches.reads()).toBe(2);
  });

  it("does not let a steady stream of changes postpone the refresh", async () => {
    const fetches = installPagedFetch();
    let refreshKey = 0;
    const view = renderHook(() => useWebProjectHistory({ project, gatewayUrl: "https://example.test", listed, refreshKey, enabled: true, botClient }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2 * PAGE_MS + 10); });
    expect(fetches.reads()).toBe(1);
    // A change every 100 ms for long after the first read: a refresh still starts within the window.
    for (let tick = 0; tick < 10; tick += 1) {
      refreshKey += 1;
      view.rerender();
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    }
    expect(fetches.reads()).toBeGreaterThanOrEqual(2);
    expect(PROJECT_HISTORY_REFRESH_DELAY_MS).toBeLessThanOrEqual(1_000);
  });

  it("cancels an in-flight read when the Project changes", async () => {
    const fetches = installPagedFetch();
    let current = project;
    const view = renderHook(() => useWebProjectHistory({ project: current, gatewayUrl: "https://example.test", listed, enabled: true, botClient }));
    // Switch while the old Project's first page is still in flight.
    await act(async () => { await vi.advanceTimersByTimeAsync(PAGE_MS / 2); });
    current = { id: "proj_b", slug: "proj_b", name: "Beta" };
    view.rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    // The old Project stopped after its first page; the new one read both of its pages.
    expect(fetches.calls).toEqual(["first", "first", "chatcur_next"]);
  });
});

describe("chat membership events", () => {
  it("counts only changes that can move, add or remove a Chat", () => {
    for (const eventType of ["chat.created", "chat.updated", "chat.deleted", "chat.user_state_updated", "migration.completed", "bot.created", "bot.authority.changed"]) {
      expect(isChatMembershipEvent({ type: "chat.changed", eventType } as never)).toBe(true);
    }
    for (const eventType of ["run.activity", "run.message", "run.completed", "turn.accepted", "queue.enqueued", "interaction.requested", "bot.task.updated"]) {
      expect(isChatMembershipEvent({ type: "chat.changed", eventType } as never)).toBe(false);
    }
    expect(isChatMembershipEvent({ type: "chat.full_refresh" } as never)).toBe(true);
  });
});
