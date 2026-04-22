import { describe, it, expect, vi } from "vitest";
import { createSyncPeerLifecycle } from "../../../packages/gateway/src/sync/ws-peer-lifecycle.js";

function createRegistry() {
  return {
    registerPeer: vi.fn().mockImplementation((_userId, params) => ({
      ...params,
      userId: "user-1",
      connectedAt: Date.now(),
    })),
    removePeer: vi.fn(),
  };
}

describe("createSyncPeerLifecycle", () => {
  it("proxies the live websocket readyState when registering peers", () => {
    const registry = createRegistry();
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };
    const lifecycle = createSyncPeerLifecycle(registry as any, "user-1", ws);

    lifecycle.subscribe({
      peerId: "peer-1",
      hostname: "mbp",
      platform: "darwin",
      clientVersion: "0.1.0",
    });

    const connection = registry.registerPeer.mock.calls[0]![2];
    expect(connection.readyState).toBe(1);
    ws.readyState = 3;
    expect(connection.readyState).toBe(3);
  });

  it("removes the active peer on close", () => {
    const registry = createRegistry();
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };
    const lifecycle = createSyncPeerLifecycle(registry as any, "user-1", ws);

    lifecycle.subscribe({
      peerId: "peer-1",
      hostname: "mbp",
      platform: "darwin",
      clientVersion: "0.1.0",
    });
    lifecycle.close();

    expect(registry.removePeer).toHaveBeenCalledWith("user-1", "peer-1");
  });

  it("keeps the previous active peer when a replacement registration throws", () => {
    const registry = createRegistry();
    registry.registerPeer
      .mockImplementationOnce((_userId, params) => ({
        ...params,
        userId: "user-1",
        connectedAt: Date.now(),
      }))
      .mockImplementationOnce(() => {
        throw new Error("register failed");
      });
    const ws = {
      readyState: 1,
      send: vi.fn(),
    };
    const lifecycle = createSyncPeerLifecycle(registry as any, "user-1", ws);

    lifecycle.subscribe({
      peerId: "peer-1",
      hostname: "mbp",
      platform: "darwin",
      clientVersion: "0.1.0",
    });

    expect(() =>
      lifecycle.subscribe({
        peerId: "peer-2",
        hostname: "mbp",
        platform: "darwin",
        clientVersion: "0.1.0",
      }),
    ).toThrow("register failed");

    expect(registry.removePeer).not.toHaveBeenCalledWith("user-1", "peer-1");

    lifecycle.close();

    expect(registry.removePeer).toHaveBeenLastCalledWith("user-1", "peer-1");
  });
});
