import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { CanonicalChatEventSource, CanonicalChatInvalidation } from "../../desktop/src/renderer/src/lib/canonical-chat-client";
import { wireCanonicalChatBadge } from "../../desktop/src/renderer/src/lib/canonical-chat-badge";
import { canonicalChatRecord } from "./canonical-chat-workspace-test-utils";

function record(id: string, unread = true): CanonicalChatRecord {
  return { ...canonicalChatRecord, chat: { ...canonicalChatRecord.chat, id }, readState: {
    unread, markedUnread: false, latestIncomingSeq: 2, readThroughSeq: unread ? 1 : 2, version: 1,
  } };
}
function setup(list = vi.fn(async () => ({ items: [record("chat_a")] }))) {
  let listener: (event: CanonicalChatInvalidation) => void = () => undefined;
  const dispose = vi.fn();
  const eventSource: Pick<CanonicalChatEventSource, "subscribe"> = {
    subscribe: vi.fn((callback) => { listener = callback; return { dispose }; }),
  };
  const setBadge = vi.fn(async (_count: number) => undefined);
  const cleanup = wireCanonicalChatBadge({ client: { list }, eventSource, setBadge });
  return { list, setBadge, cleanup, dispose, refresh: () => listener({ type: "chat.full_refresh" }) };
}
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("canonical Chat Dock badge", () => {
  it("counts the same unread state as Chat, across projects, and clears after reading", async () => {
    const state = setup();
    await settle();
    expect(state.list).toHaveBeenCalledWith({ unreadOnly: true, limit: 100 });
    expect(state.setBadge).toHaveBeenLastCalledWith(1);
    state.list.mockResolvedValue({ items: [record("chat_a", false)] });
    state.refresh();
    await settle();
    expect(state.setBadge).toHaveBeenLastCalledWith(0);
    state.cleanup();
  });
  it("keeps an explicitly read Chat clear even when its completion is unacknowledged", async () => {
    const readChat: CanonicalChatRecord = {
      ...record("chat_read", false),
      latestSuccessfulCompletion: {
        runId: "run_completed", completedAt: "2026-09-17T00:00:00.000Z", unacknowledged: true,
      },
    };
    const state = setup(vi.fn(async () => ({ items: [readChat] })));
    await settle();
    expect(state.setBadge).toHaveBeenLastCalledWith(0);
    state.cleanup();
  });
  it("deduplicates paginated history and counts unread conversations only", async () => {
    const list = vi.fn().mockResolvedValueOnce({ items: [record("chat_a")], nextCursor: "page2" })
      .mockResolvedValueOnce({ items: [record("chat_a"), record("chat_b"), record("chat_c", false)] });
    const state = setup(list);
    await settle();
    expect(list).toHaveBeenLastCalledWith({ unreadOnly: true, limit: 100, cursor: "page2" });
    expect(state.setBadge).toHaveBeenLastCalledWith(2);
    state.cleanup();
  });
  it("bounds a large unread history at the native badge limit", async () => {
    const list = vi.fn().mockImplementation(async () => ({
      items: Array.from({ length: 100 }, (_, i) => record(`chat_${list.mock.calls.length}_${i}`)),
      nextCursor: `page${list.mock.calls.length}`,
    }));
    const state = setup(list);
    await settle();
    expect(list).toHaveBeenCalledTimes(10);
    expect(state.setBadge).toHaveBeenLastCalledWith(999);
    state.cleanup();
  });
  it("discards old runtime results and clears on teardown", async () => {
    let resolve!: (value: { items: CanonicalChatRecord[] }) => void;
    const state = setup(vi.fn(() => new Promise((done) => { resolve = done; })));
    state.cleanup();
    resolve({ items: [record("chat_old")] });
    await settle();
    expect(state.setBadge.mock.calls.every(([count]) => count === 0)).toBe(true);
    expect(state.dispose).toHaveBeenCalledOnce();
  });
  it("coalesces events during loading and then reads the latest state", async () => {
    let resolve!: (value: { items: CanonicalChatRecord[] }) => void;
    const list = vi.fn().mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
      .mockResolvedValue({ items: [] });
    const state = setup(list);
    state.refresh(); state.refresh();
    resolve({ items: [record("chat_a")] });
    await settle();
    expect(list).toHaveBeenCalledTimes(2);
    expect(state.setBadge).toHaveBeenLastCalledWith(0);
    state.cleanup();
  });
  it("clears an in-flight native write on teardown before its acknowledgement arrives", async () => {
    let resolveWrite!: () => void;
    const setBadge = vi.fn((count: number) => count === 1
      ? new Promise<void>((resolve) => { resolveWrite = resolve; })
      : Promise.resolve());
    const cleanup = wireCanonicalChatBadge({
      client: { list: vi.fn(async () => ({ items: [record("chat_a")] })) },
      eventSource: null, setBadge,
    });
    await settle();
    cleanup();
    expect(setBadge.mock.calls.map(([count]) => count)).toEqual([0, 1, 0]);
    resolveWrite();
    await settle();
    expect(setBadge).toHaveBeenLastCalledWith(0);
  });
  it("retries failed reads without replacing a known count with a false zero", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const state = setup();
    await settle();
    state.list.mockRejectedValueOnce(new Error("offline"));
    state.refresh();
    await settle();
    expect(state.setBadge).toHaveBeenLastCalledWith(1);
    state.list.mockResolvedValue({ items: [] });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(state.setBadge).toHaveBeenLastCalledWith(0);
    state.cleanup();
  });
});
