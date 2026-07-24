// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_QUEUED_MESSAGE_CHARS,
  MAX_QUEUED_MESSAGES_PER_THREAD,
  MAX_QUEUED_THREADS,
  useCodingAgentMessageQueue,
} from "../../desktop/src/renderer/src/features/coding-agents/message-queue-store";

function reset() {
  useCodingAgentMessageQueue.setState({ queues: {} });
}

describe("coding-agent message queue store", () => {
  afterEach(reset);

  it("enqueues messages in FIFO order per thread", () => {
    const first = useCodingAgentMessageQueue.getState().enqueue("thread_a", "first follow-up");
    const second = useCodingAgentMessageQueue.getState().enqueue("thread_a", "second follow-up");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.id).not.toBe(second?.id);
    const queued = useCodingAgentMessageQueue.getState().queues.thread_a;
    expect(queued.map((message) => message.text)).toEqual(["first follow-up", "second follow-up"]);
  });

  it("keeps queues independent per thread", () => {
    useCodingAgentMessageQueue.getState().enqueue("thread_a", "for a");
    useCodingAgentMessageQueue.getState().enqueue("thread_b", "for b");

    const { queues } = useCodingAgentMessageQueue.getState();
    expect(queues.thread_a.map((message) => message.text)).toEqual(["for a"]);
    expect(queues.thread_b.map((message) => message.text)).toEqual(["for b"]);
  });

  it("rejects empty or whitespace-only messages", () => {
    expect(useCodingAgentMessageQueue.getState().enqueue("thread_a", "")).toBeNull();
    expect(useCodingAgentMessageQueue.getState().enqueue("thread_a", "   \n ")).toBeNull();
    expect(useCodingAgentMessageQueue.getState().queues.thread_a).toBeUndefined();
  });

  it("rejects messages beyond the turn schema character cap", () => {
    const oversized = "x".repeat(MAX_QUEUED_MESSAGE_CHARS + 1);
    expect(useCodingAgentMessageQueue.getState().enqueue("thread_a", oversized)).toBeNull();
    const exact = "x".repeat(MAX_QUEUED_MESSAGE_CHARS);
    expect(useCodingAgentMessageQueue.getState().enqueue("thread_a", exact)).not.toBeNull();
  });

  it("caps the queue length per thread", () => {
    for (let index = 0; index < MAX_QUEUED_MESSAGES_PER_THREAD; index += 1) {
      expect(useCodingAgentMessageQueue.getState().enqueue("thread_a", `message ${index}`)).not.toBeNull();
    }
    expect(useCodingAgentMessageQueue.getState().enqueue("thread_a", "one too many")).toBeNull();
    expect(useCodingAgentMessageQueue.getState().queues.thread_a).toHaveLength(MAX_QUEUED_MESSAGES_PER_THREAD);
  });

  it("removes a queued message and prunes the empty thread entry", () => {
    const keep = useCodingAgentMessageQueue.getState().enqueue("thread_a", "keep");
    const drop = useCodingAgentMessageQueue.getState().enqueue("thread_a", "drop");
    expect(keep && drop).toBeTruthy();

    useCodingAgentMessageQueue.getState().removeQueued("thread_a", drop!.id);
    expect(useCodingAgentMessageQueue.getState().queues.thread_a.map((message) => message.text)).toEqual(["keep"]);

    useCodingAgentMessageQueue.getState().removeQueued("thread_a", keep!.id);
    expect(useCodingAgentMessageQueue.getState().queues.thread_a).toBeUndefined();
  });

  it("requeues a drained message back to the front without duplicating it", () => {
    const first = useCodingAgentMessageQueue.getState().enqueue("thread_a", "first");
    useCodingAgentMessageQueue.getState().enqueue("thread_a", "second");
    useCodingAgentMessageQueue.getState().removeQueued("thread_a", first!.id);

    useCodingAgentMessageQueue.getState().requeueFront("thread_a", first!);
    expect(useCodingAgentMessageQueue.getState().queues.thread_a.map((message) => message.text)).toEqual([
      "first",
      "second",
    ]);

    // A repeated requeue of the same id is a no-op (drain retry safety).
    useCodingAgentMessageQueue.getState().requeueFront("thread_a", first!);
    expect(useCodingAgentMessageQueue.getState().queues.thread_a).toHaveLength(2);
  });

  it("clears a thread queue", () => {
    useCodingAgentMessageQueue.getState().enqueue("thread_a", "one");
    useCodingAgentMessageQueue.getState().enqueue("thread_b", "two");
    useCodingAgentMessageQueue.getState().clearThreadQueue("thread_a");

    const { queues } = useCodingAgentMessageQueue.getState();
    expect(queues.thread_a).toBeUndefined();
    expect(queues.thread_b).toHaveLength(1);
  });

  it("evicts the stalest thread when the global thread cap is reached", () => {
    // Fill to capacity with deterministic timestamps: thread_0 is oldest.
    let now = 1_000;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      for (let index = 0; index < MAX_QUEUED_THREADS; index += 1) {
        now += 1;
        useCodingAgentMessageQueue.getState().enqueue(`thread_${index}`, "queued");
      }
      expect(Object.keys(useCodingAgentMessageQueue.getState().queues)).toHaveLength(MAX_QUEUED_THREADS);

      now += 1;
      expect(useCodingAgentMessageQueue.getState().enqueue("thread_new", "fresh")).not.toBeNull();
      const { queues } = useCodingAgentMessageQueue.getState();
      expect(Object.keys(queues)).toHaveLength(MAX_QUEUED_THREADS);
      expect(queues.thread_0).toBeUndefined();
      expect(queues.thread_new).toHaveLength(1);
    } finally {
      Date.now = realNow;
    }
  });
});
