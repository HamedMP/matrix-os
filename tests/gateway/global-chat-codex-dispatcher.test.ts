import { describe, expect, it, vi } from "vitest";
import { createGlobalChatCodexDispatcher } from
  "../../packages/gateway/src/global-chat-codex-dispatcher.js";

const principal = { userId: "owner", source: "configured-container" as const };

function eventBase(type: string, eventId: string, threadId = "thread_codex") {
  return { type, eventId, threadId, occurredAt: "2026-08-22T00:00:00.000Z" };
}

function harness() {
  let sink: ((input: { ownerId: string; threadId: string; events: unknown[] }) => void) | null = null;
  const createThread = vi.fn(async () => ({
    existing: false,
    snapshot: {
      thread: { id: "thread_codex", providerId: "codex" },
      events: { items: [], nextCursor: null, hasMore: false },
    },
  }));
  const acceptTurn = vi.fn(async () => ({
    threadId: "thread_codex",
    turnId: "turn_1",
    status: "accepted",
    acceptedAt: "2026-08-22T00:00:00.000Z",
  }));
  const abortThread = vi.fn(async () => ({ thread: { id: "thread_codex" }, events: [] }));
  const dispatcher = createGlobalChatCodexDispatcher({
    threads: {
      createThread,
      acceptTurn,
      abortThread,
      getThread: vi.fn(async () => ({
        thread: { id: "thread_codex", providerId: "codex" },
        events: { items: [], nextCursor: null, hasMore: false },
      })),
      registerEventSink: vi.fn((next) => {
        sink = next as typeof sink;
        return { dispose: vi.fn() };
      }),
    } as never,
  });
  return {
    dispatcher,
    createThread,
    acceptTurn,
    abortThread,
    publish(events: unknown[]) {
      sink?.({ ownerId: principal.userId, threadId: "thread_codex", events });
    },
  };
}

describe("Global Chat Codex dispatcher", () => {
  it("adapts Global Chat request ids to the coding-agent request contract", async () => {
    const runtime = harness();
    const pending = runtime.dispatcher.dispatch({
      principal,
      text: "inspect this computer",
      requestId: "req-global-hyphenated",
      onEvent: () => undefined,
    });

    await vi.waitFor(() => expect(runtime.createThread).toHaveBeenCalledTimes(1));
    expect(runtime.createThread.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      clientRequestId: expect.stringMatching(/^req_[A-Za-z0-9_-]+$/),
    }));
    runtime.publish([{ ...eventBase("thread.completed", "event_done"), outcome: "completed" }]);

    await expect(pending).resolves.toEqual({ threadId: "thread_codex" });
    runtime.dispatcher.dispose();
  });

  it("starts a root Codex thread and translates its live events to kernel frames", async () => {
    const runtime = harness();
    const frames: unknown[] = [];
    const pending = runtime.dispatcher.dispatch({
      principal,
      text: "inspect this computer",
      requestId: "req_first",
      onEvent: (frame) => frames.push(frame),
    });

    await vi.waitFor(() => expect(runtime.createThread).toHaveBeenCalledWith(principal, expect.objectContaining({
      providerId: "codex",
      prompt: "inspect this computer",
      clientRequestId: expect.stringMatching(/^req_[A-Za-z0-9_-]+$/),
    })));
    runtime.publish([
      { ...eventBase("assistant.text.delta", "event_1"), messageId: "msg_1", delta: "Hello" },
      { ...eventBase("thread.completed", "event_2"), outcome: "completed" },
    ]);

    await expect(pending).resolves.toEqual({ threadId: "thread_codex" });
    expect(frames).toEqual([
      { type: "kernel:init", sessionId: "thread_codex", providerId: "codex", requestId: "req_first" },
      { type: "kernel:text", text: "Hello", requestId: "req_first" },
      { type: "kernel:result", data: { outcome: "completed" }, requestId: "req_first" },
    ]);
    runtime.dispatcher.dispose();
  });

  it("resumes only the existing Codex thread and aborts it through the coding-agent store", async () => {
    const runtime = harness();
    const controller = new AbortController();
    const pending = runtime.dispatcher.dispatch({
      principal,
      threadId: "thread_codex",
      text: "continue",
      requestId: "req_second",
      signal: controller.signal,
      onEvent: () => undefined,
    });

    await vi.waitFor(() => expect(runtime.acceptTurn).toHaveBeenCalledTimes(1));
    const agentRequestId = runtime.acceptTurn.mock.calls[0]?.[2].clientRequestId;
    expect(runtime.acceptTurn).toHaveBeenCalledWith(
      principal,
      "thread_codex",
      { message: "continue", clientRequestId: agentRequestId },
    );
    expect(agentRequestId).toMatch(/^req_[A-Za-z0-9_-]+$/);
    controller.abort();
    await vi.waitFor(() => expect(runtime.abortThread).toHaveBeenCalledWith(
      principal,
      "thread_codex",
      agentRequestId,
    ));
    runtime.publish([{ ...eventBase("thread.completed", "event_abort"), outcome: "aborted" }]);

    await expect(pending).resolves.toEqual({ threadId: "thread_codex" });
    runtime.dispatcher.dispose();
  });

  it("fails closed before replay dedupe capacity can evict an active event id", async () => {
    const runtime = harness();
    const frames: unknown[] = [];
    const pending = runtime.dispatcher.dispatch({
      principal,
      text: "produce a long response",
      requestId: "req_capacity",
      onEvent: (frame) => frames.push(frame),
    });

    await vi.waitFor(() => expect(runtime.createThread).toHaveBeenCalledTimes(1));
    runtime.publish(Array.from({ length: 2_001 }, (_, index) => ({
      ...eventBase("assistant.text.delta", `event_${index}`),
      messageId: "msg_capacity",
      delta: "x",
    })));

    await expect(pending).rejects.toThrow("Codex event tracking capacity exceeded");
    expect(frames).toHaveLength(2_001); // init plus the 2,000 safely tracked deltas
    runtime.dispatcher.dispose();
  });
});
