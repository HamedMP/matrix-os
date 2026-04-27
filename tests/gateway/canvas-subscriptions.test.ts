import { describe, expect, it, vi } from "vitest";
import { CanvasSubscriptionHub } from "../../packages/gateway/src/canvas/subscriptions.js";

describe("CanvasSubscriptionHub", () => {
  it("authorizes subscriptions before registering a connection", async () => {
    const hub = new CanvasSubscriptionHub({
      authorize: vi.fn().mockResolvedValue(false),
    });

    await expect(hub.subscribe({
      connectionId: "conn_1",
      canvasId: "cnv_0123456789abcdef",
      userId: "user_a",
      send: vi.fn(),
    })).rejects.toThrow("Unauthorized");
    expect(hub.subscriberCount).toBe(0);
  });

  it("validates inbound frames at 32 KiB", () => {
    const hub = new CanvasSubscriptionHub();
    expect(() => hub.validateInboundFrame(JSON.stringify({ type: "presence", cursor: { x: 1, y: 2 } }))).not.toThrow();
    expect(() => hub.validateInboundFrame("x".repeat(32 * 1024 + 1))).toThrow();
  });

  it("validates bounded presence frames before storing them", () => {
    const hub = new CanvasSubscriptionHub();

    expect(hub.validatePresenceFrame({
      type: "presence",
      cursor: { x: 1, y: 2 },
      viewport: { x: 0, y: 0, zoom: 1 },
      selection: ["node_a"],
    })).toMatchObject({ type: "presence" });
    expect(() => hub.validatePresenceFrame({
      type: "presence",
      payload: { nested: "unexpected" },
    })).toThrow();
    expect(() => hub.validatePresenceFrame({
      type: "presence",
      selection: Array.from({ length: 101 }, (_, index) => `node_${index}`),
    })).toThrow();
  });

  it("caps subscribers globally and per canvas/user", async () => {
    const hub = new CanvasSubscriptionHub({
      maxSubscribers: 12,
      maxSubscribersPerCanvasUser: 10,
      authorize: vi.fn().mockResolvedValue(true),
    });

    for (let index = 0; index < 10; index += 1) {
      await hub.subscribe({
        connectionId: `conn_${index}`,
        canvasId: "cnv_0123456789abcdef",
        userId: "user_a",
        send: vi.fn(),
      });
    }

    await expect(hub.subscribe({
      connectionId: "conn_over_canvas",
      canvasId: "cnv_0123456789abcdef",
      userId: "user_a",
      send: vi.fn(),
    })).rejects.toThrow("Too many subscribers");

    await hub.subscribe({
      connectionId: "conn_other_1",
      canvasId: "cnv_other123456789",
      userId: "user_b",
      send: vi.fn(),
    });
    await hub.subscribe({
      connectionId: "conn_other_2",
      canvasId: "cnv_other123456789",
      userId: "user_c",
      send: vi.fn(),
    });

    await expect(hub.subscribe({
      connectionId: "conn_global_over",
      canvasId: "cnv_over123456789",
      userId: "user_d",
      send: vi.fn(),
    })).rejects.toThrow("Too many subscribers");
  });

  it("evicts stale subscribers before enforcing the global cap", async () => {
    let currentTime = 1_000;
    const hub = new CanvasSubscriptionHub({
      maxSubscribers: 2,
      subscriberTtlMs: 30_000,
      now: () => currentTime,
    });

    await hub.subscribe({
      connectionId: "conn_stale",
      canvasId: "cnv_0123456789abcdef",
      userId: "user_a",
      send: vi.fn(),
    });
    currentTime = 4_000;
    await hub.subscribe({
      connectionId: "conn_active",
      canvasId: "cnv_0123456789abcdef",
      userId: "user_b",
      send: vi.fn(),
    });
    currentTime = 32_001;
    await hub.subscribe({
      connectionId: "conn_new",
      canvasId: "cnv_0123456789abcdef",
      userId: "user_c",
      send: vi.fn(),
    });

    expect(hub.subscriberCount).toBe(2);
  });

  it("evicts expired presence and sends generic errors", async () => {
    let currentTime = 1_000;
    const send = vi.fn();
    const hub = new CanvasSubscriptionHub({ presenceTtlMs: 30_000, now: () => currentTime });

    await hub.subscribe({
      connectionId: "conn_1",
      canvasId: "cnv_0123456789abcdef",
      userId: "user_a",
      send,
    });
    hub.updatePresence("conn_1", { cursor: { x: 1, y: 2 } });
    expect(hub.presenceForCanvas("cnv_0123456789abcdef")).toHaveLength(1);
    currentTime = 40_001;
    expect(hub.presenceForCanvas("cnv_0123456789abcdef")).toHaveLength(0);

    hub.sendSafeError("conn_1", new Error("postgres://secret /home/deploy"));
    expect(send).toHaveBeenCalledWith(JSON.stringify({ type: "error", error: "Canvas realtime failed" }));
  });

  it("isolates broadcast send failures to the failing subscriber", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const firstSend = vi.fn(() => {
      throw new Error("socket closed");
    });
    const secondSend = vi.fn();
    const hub = new CanvasSubscriptionHub();

    await hub.subscribe({
      connectionId: "conn_1",
      canvasId: "cnv_0123456789abcdef",
      userId: "user_a",
      send: firstSend,
    });
    await hub.subscribe({
      connectionId: "conn_2",
      canvasId: "cnv_0123456789abcdef",
      userId: "user_b",
      send: secondSend,
    });

    hub.broadcast("cnv_0123456789abcdef", { type: "canvas:updated" });

    expect(firstSend).toHaveBeenCalled();
    expect(secondSend).toHaveBeenCalledWith(JSON.stringify({ type: "canvas:updated" }));
    expect(consoleSpy).toHaveBeenCalledWith("[canvas/realtime] Broadcast send failed:", "socket closed");
    consoleSpy.mockRestore();
  });

  it("sends shutdown notices and clears subscribers on close", async () => {
    const send = vi.fn();
    const hub = new CanvasSubscriptionHub();

    await hub.subscribe({
      connectionId: "conn_1",
      canvasId: "cnv_0123456789abcdef",
      userId: "user_a",
      send,
    });
    hub.close();

    expect(send).toHaveBeenCalledWith(JSON.stringify({ type: "server:closing" }));
    expect(hub.subscriberCount).toBe(0);
  });
});
