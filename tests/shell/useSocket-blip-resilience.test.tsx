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
});
