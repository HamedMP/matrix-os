// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { useCanonicalChatRouteController } from "@desktop/renderer/src/features/chat/use-canonical-chat-route-controller";

const record = { chat: { id: "chat_stop", ownerScope: { type: "personal" as const, ownerId: "owner_test" },
  title: "Stop", lifecycle: "active" as const, attention: "none" as const, revision: 1, messageCount: 0,
  createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z" } };
const stopped = { record: { ...record, chat: { ...record.chat, revision: 2 } }, messages: [], turns: [], runs: [], activities: [] };
const running = { ...stopped, record: { ...record, activeRun: { runId: "run_stop", turnId: "turn_stop", status: "running" as const } } };
const events = { connectionState: () => "open" as const, subscribeConnectionState: () => ({ dispose() {} }),
  subscribe: () => ({ dispose() {} }) };

describe("Electron Stop snapshot recovery", () => {
  it.each(["recover", "switch", "deactivate", "unmount"])(
    "retains the acknowledged Stop read obligation even while SSE reports open: %s", async (action) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const getDetail = vi.fn().mockResolvedValueOnce(running).mockRejectedValueOnce(new TypeError("offline"))
        .mockResolvedValue(stopped);
      const cancelRun = vi.fn(async () => ({ cancellation: "aborted" }));
      const client = { list: vi.fn(async () => ({ items: [record] })), getDetail, cancelRun } as unknown as CanonicalChatClient;
      const hook = renderHook(({ active }) => useCanonicalChatRouteController({ client, projectId: null, active,
        initialChatId: record.chat.id, eventSource: events }), { initialProps: { active: true } });
      try {
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        await act(async () => { await hook.result.current.cancelActiveRun(); });
        expect(cancelRun).toHaveBeenCalledOnce();
        expect(getDetail).toHaveBeenCalledTimes(2);
        if (action === "switch") act(() => hook.result.current.selectChat(null));
        if (action === "deactivate") hook.rerender({ active: false });
        if (action === "unmount") hook.unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
        if (action === "recover") {
          expect(hook.result.current.detail?.record.activeRun).toBeUndefined();
          expect(getDetail).toHaveBeenCalledTimes(3);
          await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
          expect(getDetail).toHaveBeenCalledTimes(3);
        } else expect(getDetail).toHaveBeenCalledTimes(2);
        expect(cancelRun).toHaveBeenCalledOnce();
      } finally { hook.unmount(); vi.useRealTimers(); warn.mockRestore(); }
    },
  );
});

it("drops a pending Stop read obligation when the auth/runtime identity changes with the same client", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const nextRunning = { ...running, record: { ...running.record,
    activeRun: { ...running.record.activeRun, runId: "run_next_source" } } };
  const getDetail = vi.fn().mockResolvedValueOnce(running).mockRejectedValueOnce(new TypeError("offline"))
    .mockResolvedValue(nextRunning);
  const client = { list: vi.fn(async () => ({ items: [record] })), getDetail,
    cancelRun: vi.fn(async () => ({ cancellation: "aborted" })) } as unknown as CanonicalChatClient;
  const hook = renderHook(({ identity }) => useCanonicalChatRouteController({ client, admissionIdentity: identity,
    projectId: null, active: true, initialChatId: record.chat.id, eventSource: events }),
    { initialProps: { identity: "runtime:auth1" } });
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await hook.result.current.cancelActiveRun(); });
    expect(getDetail).toHaveBeenCalledTimes(2);
    hook.rerender({ identity: "runtime:auth2" });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(hook.result.current.detail?.record.activeRun?.runId).toBe("run_next_source");
    const initialReads = getDetail.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(getDetail).toHaveBeenCalledTimes(initialReads);
    expect(client.cancelRun).toHaveBeenCalledOnce();
  } finally { hook.unmount(); vi.useRealTimers(); warn.mockRestore(); }
});
