import { describe, expect, it, vi } from "vitest";
import { buildDispatchFailureReplayMessage } from "../../packages/gateway/src/conversation-dispatch-failure.js";

describe("conversation dispatch failure replay messages", () => {
  it("stamps a dispatch failure once for both replay buffer and live socket", () => {
    let sequence = 0;
    const stamp = vi.fn((message) => ({
      ...message,
      eventId: `sess-1:req-1:${sequence++}`,
    }));

    const replay = buildDispatchFailureReplayMessage({
      activeSessionId: "sess-1",
      requestId: "req-1",
      clientMessage: "Request failed",
      stamp,
    });

    expect(stamp).toHaveBeenCalledTimes(1);
    expect(replay.runMessage).toEqual({
      type: "kernel:error",
      message: "Request failed",
      requestId: "req-1",
      eventId: "sess-1:req-1:0",
    });
    expect(replay.liveMessage).toBe(replay.runMessage);
  });
});
