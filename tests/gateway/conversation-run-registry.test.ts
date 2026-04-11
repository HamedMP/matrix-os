import { describe, it, expect } from "vitest";
import {
  ConversationRunRegistry,
  type ConversationRunMessage,
} from "../../packages/gateway/src/conversation-run-registry.js";

describe("ConversationRunRegistry", () => {
  it("replays buffered messages to new subscribers and streams future ones", () => {
    const registry = new ConversationRunRegistry({
      maxRuns: 5,
      maxEventsPerRun: 10,
    });

    const init: ConversationRunMessage = { type: "kernel:init", sessionId: "sess-1" };
    const text: ConversationRunMessage = { type: "kernel:text", text: "Hello" };
    const nextText: ConversationRunMessage = { type: "kernel:text", text: " world" };

    registry.begin("sess-1");
    registry.publish("sess-1", init);
    registry.publish("sess-1", text);

    const received: ConversationRunMessage[] = [];
    const detach = registry.attach("sess-1", (msg) => {
      received.push(msg);
    });

    expect(detach).not.toBeNull();
    expect(received).toEqual([init, text]);

    registry.publish("sess-1", nextText);

    expect(received).toEqual([init, text, nextText]);

    detach?.();
    registry.publish("sess-1", { type: "kernel:text", text: "!" });

    expect(received).toEqual([init, text, nextText]);
  });

  it("keeps only the tail of large runs", () => {
    const registry = new ConversationRunRegistry({
      maxRuns: 5,
      maxEventsPerRun: 2,
    });

    registry.begin("sess-1");
    registry.publish("sess-1", { type: "kernel:init", sessionId: "sess-1" });
    registry.publish("sess-1", { type: "kernel:text", text: "A" });
    registry.publish("sess-1", { type: "kernel:text", text: "B" });

    const received: ConversationRunMessage[] = [];
    registry.attach("sess-1", (msg) => {
      received.push(msg);
    });

    expect(received).toEqual([
      { type: "kernel:text", text: "A" },
      { type: "kernel:text", text: "B" },
    ]);
  });

  it("removes runs once they complete", () => {
    const registry = new ConversationRunRegistry({
      maxRuns: 5,
      maxEventsPerRun: 10,
    });

    registry.begin("sess-1");
    registry.publish("sess-1", { type: "kernel:init", sessionId: "sess-1" });
    registry.complete("sess-1");

    expect(registry.attach("sess-1", () => {})).toBeNull();
  });

  it("evicts the oldest run when the cap is reached", () => {
    const registry = new ConversationRunRegistry({
      maxRuns: 1,
      maxEventsPerRun: 10,
    });

    registry.begin("sess-1");
    registry.publish("sess-1", { type: "kernel:init", sessionId: "sess-1" });
    registry.begin("sess-2");
    registry.publish("sess-2", { type: "kernel:init", sessionId: "sess-2" });

    expect(registry.attach("sess-1", () => {})).toBeNull();
    expect(registry.attach("sess-2", () => {})).not.toBeNull();
  });

  it("returns null instead of throwing when subscriber cap is reached", () => {
    const registry = new ConversationRunRegistry({
      maxRuns: 1,
      maxEventsPerRun: 10,
      maxSubscribersPerRun: 1,
    });

    registry.begin("sess-1");
    registry.publish("sess-1", { type: "kernel:init", sessionId: "sess-1" });

    const detach = registry.attach("sess-1", () => {});
    expect(detach).not.toBeNull();
    expect(registry.attach("sess-1", () => {})).toBeNull();
  });

  it("returns a copy of buffered messages for batched replay", () => {
    const registry = new ConversationRunRegistry({
      maxRuns: 1,
      maxEventsPerRun: 10,
    });

    registry.begin("sess-1");
    registry.publish("sess-1", { type: "kernel:init", sessionId: "sess-1" });
    registry.publish("sess-1", { type: "kernel:text", text: "Hello" });

    const replay = registry.getBufferedMessages("sess-1");
    expect(replay).toEqual([
      { type: "kernel:init", sessionId: "sess-1" },
      { type: "kernel:text", text: "Hello" },
    ]);
    expect(replay).not.toBe(registry.getBufferedMessages("sess-1"));
  });

  it("captures a buffered snapshot before streaming future messages", () => {
    const registry = new ConversationRunRegistry({
      maxRuns: 1,
      maxEventsPerRun: 10,
    });

    registry.begin("sess-1");
    registry.publish("sess-1", { type: "kernel:init", sessionId: "sess-1" });
    registry.publish("sess-1", { type: "kernel:text", text: "buffered" });

    const streamed: ConversationRunMessage[] = [];
    const attachment = registry.attachWithBufferedSnapshot("sess-1", (msg) => {
      streamed.push(msg);
    });

    expect(attachment).not.toBeNull();
    expect(attachment?.bufferedMessages).toEqual([
      { type: "kernel:init", sessionId: "sess-1" },
      { type: "kernel:text", text: "buffered" },
    ]);
    expect(streamed).toEqual([]);

    registry.publish("sess-1", { type: "kernel:text", text: "live" });
    expect(streamed).toEqual([{ type: "kernel:text", text: "live" }]);

    attachment?.detach();
    registry.publish("sess-1", { type: "kernel:text", text: "after-detach" });
    expect(streamed).toEqual([{ type: "kernel:text", text: "live" }]);
  });
});
