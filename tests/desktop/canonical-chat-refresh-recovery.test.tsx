// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CanonicalChatClient, CanonicalChatInvalidation } from "@desktop/renderer/src/lib/canonical-chat-client";
import { useCanonicalChatRouteController } from "@desktop/renderer/src/features/chat/use-canonical-chat-route-controller";

const record = {
  chat: {
    id: "chat_recovery", ownerScope: { type: "personal" as const, ownerId: "owner_test" },
    title: "Recovery", lifecycle: "active" as const, attention: "none" as const,
    revision: 1, messageCount: 0,
    createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z",
  },
};
const completed = { record, messages: [], turns: [], runs: [], activities: [] };
const running = { ...completed, record: { ...record,
  activeRun: { runId: "run_test", turnId: "turn_test", status: "running" as const },
} };

describe("Desktop event refresh recovery", () => {
  it("does not count a queue mutation twice when its stream event beats the HTTP response", async () => {
    let listener: ((event: CanonicalChatInvalidation) => void) | undefined;
    let resolveQueue!: (value: unknown) => void;
    const events = { connectionState: () => "open" as const,
      subscribeConnectionState: () => ({ dispose() {} }),
      subscribe(fn: typeof listener) { listener = fn; return { dispose() {} }; } };
    const queued = { id: "qturn_test", chatId: record.chat.id, updatedAt: record.chat.updatedAt };
    const client = { list: vi.fn(async () => ({ items: [record] })), getDetail: vi.fn(async () => running),
      queueTurn: vi.fn(() => new Promise((resolve) => { resolveQueue = resolve; })),
    } as unknown as CanonicalChatClient;
    const hook = renderHook(() => useCanonicalChatRouteController({
      client, projectId: null, active: true, initialChatId: record.chat.id, eventSource: events,
    }));
    try {
      await act(async () => {});
      let request!: Promise<unknown>;
      act(() => { request = hook.result.current.queueTurn({ parts: [{ type: "text", text: "next" }],
        selection: { instanceId: "codex_test", model: "test" }, interactionMode: "default", permissionMode: "supervised" }); });
      act(() => listener?.({ type: "chat.changed", chatId: record.chat.id, cursor: 2, revision: 2, eventType: "queue.enqueued",
        content: { type: "chat.content", event: { cursor: 2, revision: 2, chatId: record.chat.id,
          eventType: "queue.enqueued", createdAt: record.chat.createdAt }, content: {
          record: { ...running.record, chat: { ...record.chat, revision: 2 } },
        } },
      }));
      await act(async () => { resolveQueue({ queuedTurn: queued }); await request; });
      expect(hook.result.current.detail?.record.chat.revision).toBe(2);
    } finally { hook.unmount(); }
  });
  it("applies streamed text and completion without fetching detail again", async () => {
    vi.useFakeTimers();
    let listener: ((event: CanonicalChatInvalidation) => void) | undefined;
    const events = {
      connectionState: () => "open" as const,
      subscribeConnectionState: () => ({ dispose() {} }),
      subscribe(fn: typeof listener) { listener = fn; return { dispose() {} }; },
    };
    const getDetail = vi.fn(async () => running);
    const client = { list: vi.fn(async () => ({ items: [record] })), getDetail } as unknown as CanonicalChatClient;
    const hook = renderHook(() => useCanonicalChatRouteController({
      client, projectId: null, active: true, initialChatId: record.chat.id, eventSource: events,
    }));
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      const message = { id: "msg_stream", chatId: record.chat.id, seq: 1, role: "assistant" as const,
        state: "pending" as const, parts: [{ type: "text" as const, text: "hello" }], createdAt: record.chat.createdAt };
      for (const revision of [2, 3]) {
        await act(async () => {
          const eventType = revision === 2 ? "run.message" as const : "run.completed" as const;
          listener?.({ type: "chat.changed", chatId: record.chat.id, cursor: revision, revision, eventType,
            content: { type: "chat.content", event: { chatId: record.chat.id, cursor: revision, revision, eventType,
              createdAt: record.chat.createdAt }, content: {
              record: { ...(revision === 2 ? running.record : record), chat: { ...record.chat, revision } },
              ...(revision === 2 ? { messageDelta: { message, offset: 0, partIndex: 0 } }
                : { messages: [{ ...message, state: "committed" as const }] }),
            } },
          });
        });
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      expect(hook.result.current.detail?.messages[0]?.parts).toEqual([{ type: "text", text: "hello" }]);
      expect(hook.result.current.detail?.record.activeRun).toBeUndefined();
      expect(getDetail).toHaveBeenCalledOnce();
    } finally { hook.unmount(); vi.useRealTimers(); }
  });
  it.each(["recover", "backoff", "switch", "deactivate", "unmount"])(
    "retains a failed final refresh with an open stream: %s", async (action) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      let listener: ((event: CanonicalChatInvalidation) => void) | undefined;
      const events = {
        connectionState: () => "open" as const,
        subscribeConnectionState: () => ({ dispose() {} }),
        subscribe(fn: typeof listener) { listener = fn; return { dispose() { listener = undefined; } }; },
      };
      const getDetail = vi.fn().mockResolvedValueOnce(running)
        .mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValue(completed);
      const client = { list: vi.fn(async () => ({ items: [record] })), getDetail } as unknown as CanonicalChatClient;
      const hook = renderHook(({ active }) => useCanonicalChatRouteController({
        client, projectId: null, active, initialChatId: record.chat.id, eventSource: events,
      }), { initialProps: { active: true } });
      try {
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(hook.result.current.detail?.record.activeRun).toBeDefined();
        await act(async () => {
          listener?.({ type: "chat.changed", chatId: record.chat.id, cursor: 2, revision: 2, eventType: "run.completed" });
        });
        expect(getDetail).toHaveBeenCalledTimes(2);
        if (action === "backoff") {
          getDetail.mockRejectedValue(new Error("still unavailable"));
          let calls = 2;
          for (const delay of [2_000, 4_000, 8_000, 10_000, 10_000]) {
            await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1); });
            expect(getDetail).toHaveBeenCalledTimes(calls);
            await act(async () => { await vi.advanceTimersByTimeAsync(1); });
            expect(getDetail).toHaveBeenCalledTimes(++calls);
          }
          getDetail.mockResolvedValue(completed);
          await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
          expect(hook.result.current.detail?.record.activeRun).toBeUndefined();
          await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
          expect(getDetail).toHaveBeenCalledTimes(calls + 1);
          return;
        }
        if (action === "switch") act(() => hook.result.current.selectChat(null));
        if (action === "deactivate") hook.rerender({ active: false });
        if (action === "unmount") hook.unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
        if (action === "recover") {
          expect(getDetail).toHaveBeenCalledTimes(3);
          expect(hook.result.current.detail?.record.activeRun).toBeUndefined();
          expect(hook.result.current.detail).not.toBeNull();
        } else expect(getDetail).toHaveBeenCalledTimes(2);
      } finally {
        hook.unmount();
        warn.mockRestore();
        vi.useRealTimers();
      }
    },
  );
});
