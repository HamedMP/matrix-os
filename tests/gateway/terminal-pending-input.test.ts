import { describe, expect, it, vi } from "vitest";
import {
  createPendingTerminalInputQueue,
  TERMINAL_SESSION_PENDING_INPUT_MAX_BYTES,
} from "../../packages/gateway/src/shell/pending-input.js";

describe("terminal websocket pending input queue", () => {
  it("buffers and drains input frames received before a named terminal attach is ready", () => {
    const queue = createPendingTerminalInputQueue();
    const onMessage = vi.fn();

    expect(queue.enqueue(JSON.stringify({ type: "input", data: "pwd\r" }))).toBe(true);
    queue.drain(onMessage);

    expect(onMessage).toHaveBeenCalledWith(JSON.stringify({ type: "input", data: "pwd\r" }));
    expect(queue.sizeBytes).toBe(0);
  });

  it("rejects queued input once the startup cap would be exceeded", () => {
    const queue = createPendingTerminalInputQueue();

    expect(queue.enqueue("x".repeat(TERMINAL_SESSION_PENDING_INPUT_MAX_BYTES))).toBe(true);
    expect(queue.enqueue("x")).toBe(false);
  });
});
