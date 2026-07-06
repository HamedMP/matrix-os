import { describe, expect, it, vi } from "vitest";
import {
  actionIdForClientMessage,
  kernelEventToServerMessage,
  send,
  sendClientAck,
} from "../../packages/gateway/src/server/main-ws-messages.js";

describe("gateway main WebSocket message helpers", () => {
  it("maps kernel events to shell server messages without exposing raw errors", () => {
    expect(kernelEventToServerMessage({ type: "init", sessionId: "s1" }, "r1")).toEqual({
      type: "kernel:init",
      sessionId: "s1",
      requestId: "r1",
    });
    expect(kernelEventToServerMessage({ type: "text", text: "hello" }, "r1")).toEqual({
      type: "kernel:text",
      text: "hello",
      requestId: "r1",
    });
    expect(kernelEventToServerMessage({ type: "tool_start", tool: "Read" }, "r1")).toEqual({
      type: "kernel:tool_start",
      tool: "Read",
      requestId: "r1",
    });
    expect(kernelEventToServerMessage({ type: "tool_end", input: { ok: true } }, "r1")).toEqual({
      type: "kernel:tool_end",
      input: { ok: true },
      requestId: "r1",
    });
    expect(kernelEventToServerMessage({ type: "result", data: { done: true } }, "r1")).toEqual({
      type: "kernel:result",
      data: { done: true },
      requestId: "r1",
    });
    expect(kernelEventToServerMessage({ type: "aborted" }, "r1")).toEqual({
      type: "kernel:aborted",
      requestId: "r1",
    });
  });

  it("derives stable ack ids for client actions", () => {
    expect(actionIdForClientMessage({ type: "message", text: "hi", requestId: "req-1" })).toBe("req-1");
    expect(actionIdForClientMessage({ type: "approval_response", id: "approval-1", approved: true })).toBe("approval-1");
    expect(actionIdForClientMessage({ type: "switch_session", sessionId: "s1" })).toBe("switch_session:s1");
    expect(actionIdForClientMessage({ type: "ping" })).toBeNull();
  });

  it("sends client acknowledgements only for actions with ids", () => {
    const ws = { send: vi.fn() };

    sendClientAck(ws, { type: "message", text: "hi", requestId: "req-1" }, "accepted", false);
    sendClientAck(ws, { type: "ping" }, "accepted", false);

    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws.send.mock.calls[0][0] as string)).toEqual({
      type: "client:ack",
      actionId: "req-1",
      actionType: "message",
      status: "accepted",
      retryable: false,
    });
  });

  it("returns false when a WebSocket send throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ws = {
      send: vi.fn(() => {
        throw new Error("closed");
      }),
    };

    expect(send(ws, { type: "pong" })).toBe(false);
    expect(warn).toHaveBeenCalledWith("[gateway] Main WebSocket send failed:", "Error");

    warn.mockRestore();
  });
});
