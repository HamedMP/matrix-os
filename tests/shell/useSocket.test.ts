import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MATRIX_TELEMETRY_EVENTS } from "../../packages/observability/src/events.js";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 1; // OPEN
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    MockWebSocket.instances.push(this);
    // Auto-fire onopen in next microtask to simulate real WS
    queueMicrotask(() => {
      if (this.readyState === 1) {
        this.onopen?.();
      }
    });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }

}

Object.assign(MockWebSocket, {
  OPEN: 1,
  CLOSED: 3,
  CONNECTING: 0,
});

describe("websocket auth in self-host mode", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("does not fetch a managed ws token when nginx injects standalone gateway auth", async () => {
    vi.resetModules();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", {
      location: {
        protocol: "http:",
        host: "167.233.232.103",
      },
    });
    vi.stubGlobal("document", {
      documentElement: {
        dataset: {
          matrixSelfHosted: "1",
        },
      },
    });

    const { buildAuthenticatedWebSocketUrl } = await import("../../shell/src/lib/websocket-auth.js");

    await expect(
      buildAuthenticatedWebSocketUrl("/ws", undefined, { requireToken: true }),
    ).resolves.toBe("ws://167.233.232.103/ws");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("useSocket heartbeat and resilience", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      token: "ws-token",
      expiresAt: Date.now() + 60_000,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
  });

  afterEach(async () => {
    // Finish asynchronous token/socket creation before restoring the real APIs.
    await vi.advanceTimersByTimeAsync(0);
    for (const socket of MockWebSocket.instances) {
      socket.onopen = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.doUnmock("@/lib/posthog-client");
    vi.unstubAllGlobals();
  });

  it("sends ping every 30 seconds when connected", async () => {
    vi.resetModules();
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("document", { addEventListener: vi.fn(), visibilityState: "visible" });

    const { ensureConnected, getGlobalSocket } = await import("../../shell/src/hooks/useSocket.js");
    ensureConnected();

    // Flush the queueMicrotask so onopen fires
    await vi.advanceTimersByTimeAsync(0);

    const ws = MockWebSocket.instances[0];
    expect(ws.url).toContain("token=ws-token");

    // Advance 30s for first ping
    vi.advanceTimersByTime(30_000);

    const pings = ws.sent.filter((s) => JSON.parse(s).type === "ping");
    expect(pings.length).toBeGreaterThanOrEqual(1);
  });

  it("queues messages during disconnect and replays on reconnect", async () => {
    vi.resetModules();
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("document", { addEventListener: vi.fn(), visibilityState: "visible" });

    const { ensureConnected, sendMessage } = await import("../../shell/src/hooks/useSocket.js");
    ensureConnected();

    // Flush onopen
    await vi.advanceTimersByTimeAsync(0);

    const ws1 = MockWebSocket.instances[0];

    // Simulate disconnect -- set readyState first then trigger close
    ws1.readyState = 3;
    ws1.onclose?.();

    // Messages sent while disconnected should be queued
    sendMessage({ type: "message", text: "queued1" });
    sendMessage({ type: "message", text: "queued2" });

    // Reconnect happens after backoff (1s for attempt 0)
    await vi.advanceTimersByTimeAsync(1000);
    const ws2 = MockWebSocket.instances[MockWebSocket.instances.length - 1];

    // Simulate the new socket opening
    ws2.readyState = 1;
    // Flush onopen microtask
    await vi.advanceTimersByTimeAsync(0);

    // Drain should have replayed the queued messages
    const msgs = ws2.sent.map((s) => JSON.parse(s));
    const queued = msgs.filter((m: { text?: string }) => m.text === "queued1" || m.text === "queued2");
    expect(queued).toHaveLength(2);
  });

  it("captures websocket connected and reconnect telemetry", async () => {
    vi.resetModules();
    const capturePostHogEvent = vi.fn();
    vi.doMock("@/lib/posthog-client", () => ({
      capturePostHogEvent,
      capturePostHogException: vi.fn(),
    }));
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("document", { addEventListener: vi.fn(), visibilityState: "visible" });

    const { ensureConnected } = await import("../../shell/src/hooks/useSocket.js");
    ensureConnected();
    await vi.advanceTimersByTimeAsync(0);

    expect(capturePostHogEvent).toHaveBeenCalledWith(MATRIX_TELEMETRY_EVENTS.SHELL_WS_CONNECTED);
    expect(capturePostHogEvent).not.toHaveBeenCalledWith(
      MATRIX_TELEMETRY_EVENTS.SHELL_WS_RECONNECT_STARTED,
      expect.anything(),
    );

    const ws1 = MockWebSocket.instances[0];
    ws1.readyState = 3;
    ws1.onclose?.();

    expect(capturePostHogEvent).toHaveBeenCalledWith(
      MATRIX_TELEMETRY_EVENTS.SHELL_WS_RECONNECT_STARTED,
      expect.objectContaining({ attempt: 0, visibility: "visible" }),
    );
  });

  it("shows reconnecting feedback when manual retry is clicked during initialization", async () => {
    vi.resetModules();
    const capturePostHogEvent = vi.fn();
    vi.doMock("@/lib/posthog-client", () => ({
      capturePostHogEvent,
      capturePostHogException: vi.fn(),
    }));
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("document", { addEventListener: vi.fn(), visibilityState: "visible" });

    const { getConnectionState, manualReconnect } = await import("../../shell/src/hooks/useSocket.js");

    expect(getConnectionState()).toBe("initializing");
    manualReconnect();

    expect(getConnectionState()).toBe("reconnecting");
    expect(capturePostHogEvent).toHaveBeenCalledWith(
      MATRIX_TELEMETRY_EVENTS.SHELL_WS_RECONNECT_STARTED,
      expect.objectContaining({ attempt: 0, visibility: "visible" }),
    );
  });
});
