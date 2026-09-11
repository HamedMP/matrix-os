// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCanonicalChatState } from "../../shell/src/hooks/useCanonicalChatState.js";

vi.mock("@/hooks/useSocket", () => ({ useSocket: () => ({ connected: true }) }));
const record = {
  chat: {
    id: "chat_recovery", ownerScope: { type: "personal", ownerId: "owner_test" },
    title: "Recovery", lifecycle: "active", attention: "none", revision: 1, messageCount: 1,
    createdAt: "2026-09-04T00:00:00.000Z", updatedAt: "2026-09-04T00:00:00.000Z",
  },
};
function snapshot(text: string, running = true) {
  return Response.json({
    record: { ...record, ...(running ? {
      activeRun: { runId: "run_test", turnId: "cturn_test", status: "running" },
    } : {}) },
    messages: [{ id: "msg_test", chatId: record.chat.id, seq: 1, role: "assistant", state: "committed",
      parts: [{ type: "text", text }], createdAt: record.chat.createdAt }],
    turns: [], runs: [], activities: [],
  });
}
function harness() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }), {
    headers: { "content-type": "text/event-stream" },
  });
  const getDetail = vi.fn(async () => snapshot("Before"));
  const list = vi.fn(async () => Response.json({ items: [record] }));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/api/chats/events?messageVersion=2")) return response;
    if (url.includes("/api/chats?")) return list();
    if (url.includes(`/api/chats/${record.chat.id}?`)) return getDetail();
    throw new Error("Unexpected request");
  }));
  controller.enqueue(new TextEncoder().encode('data: {"type":"chat.stream.attached"}\n\n'));
  return {
    getDetail, list,
    emit(cursor: number, eventType = "run.message", chatId = record.chat.id) {
      controller.enqueue(new TextEncoder().encode(`id: ${cursor}\ndata: ${JSON.stringify({
        type: "chat.event", event: { cursor, chatId, revision: cursor, eventType, createdAt: record.chat.createdAt },
      })}\n\n`));
    },
  };
}
async function tick(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Web Desktop and Web Mobile shared Chat refresh", () => {
  it.each(["focus", "stream"])("keeps an intentional new Chat empty after a %s list refresh", async (trigger) => {
    vi.useFakeTimers();
    const h = harness();
    const hook = renderHook(() => useCanonicalChatState());
    try {
      await tick();
      expect(hook.result.current.sessionId).toBe(record.chat.id);
      await act(async () => { await hook.result.current.newChat(); });
      h.list.mockImplementation(async () => Response.json({ items: [{
        ...record, chat: { ...record.chat, title: "Refreshed list" },
      }] }));
      if (trigger === "focus") {
        act(() => { window.dispatchEvent(new Event("focus")); });
      } else {
        h.emit(2, "run.completed");
      }
      await tick(250);
      expect(hook.result.current.conversations[0]?.title).toBe("Refreshed list");
      expect(hook.result.current.sessionId).toBeUndefined();
      expect(hook.result.current.messages).toEqual([]);
      expect(hook.result.current.busy).toBe(false);
      act(() => { hook.result.current.switchConversation(record.chat.id); });
      await tick();
      expect(hook.result.current.messages[0]?.content).toBe("Before");
    } finally { hook.unmount(); }
  });

  it("does not restore history when the initial list arrives after New chat", async () => {
    vi.useFakeTimers();
    const h = harness();
    let resolveList!: (response: Response) => void;
    h.list.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveList = resolve; }));
    const hook = renderHook(() => useCanonicalChatState());
    try {
      await tick();
      await act(async () => { await hook.result.current.newChat(); });
      await act(async () => { resolveList(Response.json({ items: [record] })); });
      await tick();
      expect(hook.result.current.conversations[0]?.id).toBe(record.chat.id);
      expect(hook.result.current.sessionId).toBeUndefined();
      expect(hook.result.current.messages).toEqual([]);
    } finally { hook.unmount(); }
  });

  it("shows a failed run before the next user message and hides it after successful retry", async () => {
    vi.useFakeTimers();
    const h = harness();
    let recovered = false;
    const failedRun = {
      id: "run_failed", chatId: record.chat.id, turnId: "cturn_failed", attempt: 1,
      driverKind: "codex", instanceId: "codex_default", selection: { instanceId: "codex_default", model: "test" },
      interactionMode: "default", permissionMode: "supervised", status: "failed", outcome: "failed",
      historyBoundarySeq: 0, capabilitySnapshot: { revision: "test", rootChat: true, resume: true,
        cancellation: true, attachments: [], tools: [], approvals: true, userInput: true,
        worktrees: "optional", resources: [], interactionModes: ["default"], permissionModes: ["supervised"] },
      createdAt: record.chat.createdAt, updatedAt: record.chat.updatedAt,
      startedAt: record.chat.createdAt, completedAt: record.chat.updatedAt,
    };
    h.getDetail.mockImplementation(async () => Response.json({
      record,
      messages: [1, 2].map((seq) => ({
        id: `msg_${seq}`, chatId: record.chat.id, seq, role: "user", state: "committed",
        parts: [{ type: "text", text: `Prompt ${seq}` }], createdAt: record.chat.createdAt,
      })),
      turns: [{ id: "cturn_failed", chatId: record.chat.id, inputMessageId: "msg_1", clientRequestId: "req_test",
        baseMessageSeq: 0, status: "failed", createdAt: record.chat.createdAt, updatedAt: record.chat.updatedAt },
      { id: "cturn_next", chatId: record.chat.id, inputMessageId: "msg_2", clientRequestId: "req_next",
        baseMessageSeq: 1, status: "accepted", createdAt: record.chat.createdAt, updatedAt: record.chat.updatedAt }],
      runs: [failedRun,
        ...(recovered ? [{ ...failedRun, id: "run_retry", attempt: 2, status: "completed", outcome: "completed" }] : [])],
      activities: [],
    }));
    const hook = renderHook(() => useCanonicalChatState());
    try {
      await tick();
      expect(hook.result.current.messages.map((message) => message.content)).toEqual([
        "Prompt 1", "The agent could not complete its reply. Try again or check Agents & providers.", "Prompt 2",
      ]);
      expect(hook.result.current.busy).toBe(false);
      recovered = true;
      act(() => { window.dispatchEvent(new Event("focus")); });
      await tick();
      expect(hook.result.current.messages.map((message) => message.content)).toEqual(["Prompt 1", "Prompt 2"]);
    } finally { hook.unmount(); }
  });

  it("applies slow snapshots during continuous events without concurrent detail requests", async () => {
    vi.useFakeTimers();
    const h = harness();
    const hook = renderHook(() => useCanonicalChatState());
    try {
      await tick();
      expect(hook.result.current.messages[0]?.content).toBe("Before");
      let resolve!: (response: Response) => void;
      h.getDetail.mockImplementationOnce(() => new Promise<Response>((r) => { resolve = r; }));
      h.getDetail.mockImplementation(() => new Promise<Response>(() => undefined));
      h.emit(2);
      await tick(200);
      h.emit(3);
      await tick(200);
      h.emit(4);
      await tick(200);
      expect(h.getDetail).toHaveBeenCalledTimes(2);
      await act(async () => { resolve(snapshot("Partial answer")); });
      expect(hook.result.current.messages[0]?.content).toBe("Partial answer");
      expect(h.getDetail).toHaveBeenCalledTimes(3);
      expect(h.list).toHaveBeenCalledTimes(1);
    } finally { hook.unmount(); }
  });

  it("retries the last failed snapshot even when SSE remains open", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = harness();
    const hook = renderHook(() => useCanonicalChatState());
    try {
      await tick();
      h.getDetail.mockRejectedValueOnce(new Error("temporary failure"))
        .mockImplementation(() => Promise.resolve(snapshot("Finished", false)));
      h.emit(2, "run.completed");
      await tick(200);
      await tick(10_000);
      expect(hook.result.current.messages[0]?.content).toBe("Finished");
      expect(hook.result.current.busy).toBe(false);
      expect(h.getDetail).toHaveBeenCalledTimes(3);
    } finally { hook.unmount(); }
  });

  it("does not reload the list or selected detail for another Chat's message deltas", async () => {
    vi.useFakeTimers();
    const h = harness();
    const hook = renderHook(() => useCanonicalChatState());
    try {
      await tick();
      h.emit(2, "run.message", "chat_other");
      await tick(200);
      expect(h.list).toHaveBeenCalledTimes(1);
      expect(h.getDetail).toHaveBeenCalledTimes(1);
      h.emit(3, "run.completed", "chat_other");
      await tick(200);
      expect(h.list).toHaveBeenCalledTimes(2);
    } finally { hook.unmount(); }
  });
});
