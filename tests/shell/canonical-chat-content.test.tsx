// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState.js";
vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));

it("renders streamed content and completion without any per-event detail request", async () => {
  vi.useFakeTimers();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }), {
    headers: { "content-type": "text/event-stream" },
  });
  const chat = { id: "chat_content", ownerScope: { type: "personal", ownerId: "owner_test" },
    title: "Content", lifecycle: "active", attention: "none", revision: 1, messageCount: 0,
    createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" };
  const record = { chat, activeRun: { runId: "run_content", turnId: "cturn_content", status: "running" } };
  const detail = vi.fn(async () => Response.json({ record, messages: [], runs: [], turns: [], activities: [] }));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/api/chats/events?messageVersion=2")) return stream;
    if (url.includes("/api/chats?")) return Response.json({ items: [record] });
    return detail();
  }));
  const hook = renderHook(() => useCanonicalChatState());
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const message = { id: "msg_content", chatId: chat.id, role: "assistant", state: "pending", seq: 1,
      runId: "run_content", turnId: "cturn_content", createdAt: chat.createdAt, parts: [{ type: "text", text: "hello" }] };
    const frames = [
      { type: "chat.stream.attached" }, { type: "chat.replay.end" },
      { type: "chat.content", event: { cursor: 2, revision: 2, chatId: chat.id, eventType: "run.message", createdAt: chat.createdAt },
        content: { record: { ...record, chat: { ...chat, revision: 2 } }, messageDelta: { message, partIndex: 0, offset: 0 } } },
      { type: "chat.content", event: { cursor: 3, revision: 3, chatId: chat.id, eventType: "run.completed", createdAt: chat.createdAt },
        content: { record: { chat: { ...chat, revision: 3 } }, messages: [{ ...message, state: "committed" }] } },
    ];
    controller.enqueue(new TextEncoder().encode(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("")));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(hook.result.current.messages[0]?.content).toBe("hello");
    expect(hook.result.current.busy).toBe(false);
    expect(detail).toHaveBeenCalledTimes(1);
  } finally { hook.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); }
});
