// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static autoOpen = true;

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (MockWebSocket.autoOpen && this.readyState === MockWebSocket.CONNECTING) {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.();
      }
    });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

vi.mock("@/lib/gateway", () => ({
  getGatewayUrl: () => "http://gateway.test",
  getGatewayWs: () => "ws://gateway.test/ws",
}));

vi.mock("@/lib/posthog-client", () => ({
  capturePostHogEvent: vi.fn(),
  capturePostHogException: vi.fn(),
}));

function credentialResponse() {
  return new Response(JSON.stringify({
    token: "ws-token",
    expiresAt: Date.now() + 60_000,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("useSocket short blip resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    MockWebSocket.instances = [];
    MockWebSocket.autoOpen = true;
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(credentialResponse())));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps primary interactions enabled and queues sends during a short reconnect blip", async () => {
    const { useSocket } = await import("../../shell/src/hooks/useSocket.js");

    function PrimaryInteraction() {
      const { connected, send } = useSocket();
      return (
        <button
          disabled={!connected}
          onClick={() => send({ type: "message", text: "queued during blip" })}
          type="button"
        >
          Ask Matrix
        </button>
      );
    }

    render(<PrimaryInteraction />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect((screen.getByRole("button", { name: "Ask Matrix" }) as HTMLButtonElement).disabled).toBe(false);

    const firstSocket = MockWebSocket.instances[0];
    act(() => {
      firstSocket.close();
    });

    const action = screen.getByRole("button", { name: "Ask Matrix" });
    expect((action as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(action);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    const nextSocket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(nextSocket.sent.map((raw) => JSON.parse(raw))).toContainEqual({
      type: "message",
      text: "queued during blip",
    });
  });

  it("delivers a queued outbound action at most once by request id", async () => {
    const { ensureConnected, sendMessage } = await import("../../shell/src/hooks/useSocket.js");

    ensureConnected();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    MockWebSocket.autoOpen = false;
    const firstSocket = MockWebSocket.instances[0];
    act(() => {
      firstSocket.close();
    });
    sendMessage({ type: "message", text: "first draft", requestId: "req-deduped" });
    sendMessage({ type: "message", text: "latest draft", requestId: "req-deduped" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    act(() => {
      ws.readyState = MockWebSocket.OPEN;
      ws.onopen?.();
    });

    const delivered = ws.sent.map((raw) => JSON.parse(raw));
    expect(delivered).toEqual([{ type: "message", text: "latest draft", requestId: "req-deduped" }]);
  });

  it("preserves stop requests during a short reconnect blip", async () => {
    const { ensureConnected, sendMessage } = await import("../../shell/src/hooks/useSocket.js");

    ensureConnected();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    MockWebSocket.autoOpen = false;
    const firstSocket = MockWebSocket.instances[0];
    act(() => {
      firstSocket.close();
    });
    sendMessage({ type: "abort", requestId: "req-stop" });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    act(() => {
      ws.readyState = MockWebSocket.OPEN;
      ws.onopen?.();
    });

    expect(ws.sent.map((raw) => JSON.parse(raw))).toContainEqual({
      type: "abort",
      requestId: "req-stop",
    });
  });

  it("tracks outbound action delivery acknowledgments without message content", async () => {
    const { ensureConnected, getDeliveryState, sendMessage } = await import("../../shell/src/hooks/useSocket.js");

    ensureConnected();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    const ws = MockWebSocket.instances[0];
    sendMessage({ type: "message", text: "private draft", requestId: "req-ack" });

    expect(getDeliveryState("req-ack")).toMatchObject({
      id: "req-ack",
      type: "message",
      state: "sent",
    });
    expect(JSON.stringify(getDeliveryState("req-ack"))).not.toContain("private draft");

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "client:ack",
          actionId: "req-ack",
          actionType: "message",
          status: "accepted",
        }),
      });
    });

    expect(getDeliveryState("req-ack")).toMatchObject({
      id: "req-ack",
      type: "message",
      state: "accepted",
      retryable: false,
    });
  });

  it("retries credential refresh instead of opening unauthenticated shell sockets", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: null, expiresAt: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(credentialResponse());
    vi.stubGlobal("fetch", fetchMock);

    const { getConnectionDiagnostics } = await import("../../shell/src/lib/connection-diagnostics.js");
    const { ensureConnected } = await import("../../shell/src/hooks/useSocket.js");

    ensureConnected();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(getConnectionDiagnostics()).toContainEqual(expect.objectContaining({
      event: "credential_refresh_failed",
      layer: "credential",
      route: "/ws",
    }));
    expect(JSON.stringify(getConnectionDiagnostics())).not.toMatch(/ws-token|private draft/i);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain("token=ws-token");
  });

  it("marks primary interactions unavailable after the quiet reconnect window expires", async () => {
    const { useSocket } = await import("../../shell/src/hooks/useSocket.js");

    function PrimaryInteraction() {
      const { connected } = useSocket();
      return (
        <button disabled={!connected} type="button">
          Ask Matrix
        </button>
      );
    }

    render(<PrimaryInteraction />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect((screen.getByRole("button", { name: "Ask Matrix" }) as HTMLButtonElement).disabled).toBe(false);
    MockWebSocket.autoOpen = false;

    const firstSocket = MockWebSocket.instances[0];
    act(() => {
      firstSocket.close();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect((screen.getByRole("button", { name: "Ask Matrix" }) as HTMLButtonElement).disabled).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
    });
    expect((screen.getByRole("button", { name: "Ask Matrix" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not restart the quiet window for repeated reconnect close events", async () => {
    const { useSocket } = await import("../../shell/src/hooks/useSocket.js");

    function PrimaryInteraction() {
      const { connected } = useSocket();
      return (
        <button disabled={!connected} type="button">
          Ask Matrix
        </button>
      );
    }

    render(<PrimaryInteraction />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect((screen.getByRole("button", { name: "Ask Matrix" }) as HTMLButtonElement).disabled).toBe(false);
    MockWebSocket.autoOpen = false;

    const firstSocket = MockWebSocket.instances[0];
    act(() => {
      firstSocket.close();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect((screen.getByRole("button", { name: "Ask Matrix" }) as HTMLButtonElement).disabled).toBe(false);

    act(() => {
      firstSocket.onclose?.();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
      await Promise.resolve();
    });
    expect((screen.getByRole("button", { name: "Ask Matrix" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
