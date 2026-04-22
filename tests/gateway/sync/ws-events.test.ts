import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  createPeerRegistry,
  type PeerRegistry,
  type SyncPeerConnection,
} from "../../../packages/gateway/src/sync/ws-events.js";

function mockWs(): SyncPeerConnection {
  return {
    send: vi.fn(),
    readyState: 1, // OPEN
    close: vi.fn(),
  };
}

describe("PeerRegistry", () => {
  let registry: PeerRegistry;

  beforeEach(() => {
    registry = createPeerRegistry();
  });

  describe("registerPeer", () => {
    it("registers a peer and returns peer info", () => {
      const ws = mockWs();
      const info = registry.registerPeer("user1", {
        peerId: "macbook",
        hostname: "Hameds-MBP",
        platform: "darwin",
        clientVersion: "0.1.0",
      }, ws);

      expect(info.peerId).toBe("macbook");
      expect(info.userId).toBe("user1");
    });

    it("broadcasts peer-join to existing peers", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();

      registry.registerPeer("user1", {
        peerId: "peer1",
        hostname: "host1",
        platform: "darwin",
        clientVersion: "0.1.0",
      }, ws1);

      registry.registerPeer("user1", {
        peerId: "peer2",
        hostname: "host2",
        platform: "linux",
        clientVersion: "0.1.0",
      }, ws2);

      // peer1 should receive peer-join notification about peer2
      expect(ws1.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"sync:peer-join"'),
      );
    });

    it("does not send peer-join to the joining peer itself", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();

      registry.registerPeer("user1", {
        peerId: "peer1",
        hostname: "host1",
        platform: "darwin",
        clientVersion: "0.1.0",
      }, ws1);

      registry.registerPeer("user1", {
        peerId: "peer2",
        hostname: "host2",
        platform: "linux",
        clientVersion: "0.1.0",
      }, ws2);

      // ws2 should NOT receive its own peer-join
      const ws2Calls = (ws2.send as ReturnType<typeof vi.fn>).mock.calls
        .map(([msg]: [string]) => JSON.parse(msg))
        .filter((m: any) => m.type === "sync:peer-join");
      expect(ws2Calls).toHaveLength(0);
    });
  });

  describe("removePeer", () => {
    it("removes peer and broadcasts peer-leave", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();

      registry.registerPeer("user1", {
        peerId: "peer1",
        hostname: "host1",
        platform: "darwin",
        clientVersion: "0.1.0",
      }, ws1);

      registry.registerPeer("user1", {
        peerId: "peer2",
        hostname: "host2",
        platform: "linux",
        clientVersion: "0.1.0",
      }, ws2);

      vi.clearAllMocks();
      registry.removePeer("user1", "peer1");

      // peer2 should get peer-leave for peer1
      expect(ws2.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"sync:peer-leave"'),
      );
      expect(ws2.send).toHaveBeenCalledWith(
        expect.stringContaining('"peerId":"peer1"'),
      );
    });

    it("does nothing for unknown peer", () => {
      registry.removePeer("user1", "nonexistent");
      // no throw
    });
  });

  describe("broadcastChange", () => {
    it("broadcasts sync:change to all peers except the sender", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();
      const ws3 = mockWs();

      registry.registerPeer("user1", {
        peerId: "sender",
        hostname: "h1",
        platform: "darwin",
        clientVersion: "0.1.0",
      }, ws1);

      registry.registerPeer("user1", {
        peerId: "receiver1",
        hostname: "h2",
        platform: "linux",
        clientVersion: "0.1.0",
      }, ws2);

      registry.registerPeer("user1", {
        peerId: "receiver2",
        hostname: "h3",
        platform: "linux",
        clientVersion: "0.1.0",
      }, ws3);

      vi.clearAllMocks();

      const message = {
        type: "sync:change" as const,
        files: [{ path: "test.txt", hash: "sha256:" + "a".repeat(64), size: 100, action: "update" as const }],
        peerId: "sender",
        manifestVersion: 5,
      };

      registry.broadcastChange("user1", "sender", message);

      // sender should NOT receive
      expect(ws1.send).not.toHaveBeenCalled();
      // other peers should receive
      expect(ws2.send).toHaveBeenCalledOnce();
      expect(ws3.send).toHaveBeenCalledOnce();

      const parsed = JSON.parse((ws2.send as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
      expect(parsed.type).toBe("sync:change");
      expect(parsed.manifestVersion).toBe(5);
    });

    it("does not send to peers of other users", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();

      registry.registerPeer("user1", {
        peerId: "peer-u1",
        hostname: "h1",
        platform: "darwin",
        clientVersion: "0.1.0",
      }, ws1);

      registry.registerPeer("user2", {
        peerId: "peer-u2",
        hostname: "h2",
        platform: "linux",
        clientVersion: "0.1.0",
      }, ws2);

      vi.clearAllMocks();

      registry.broadcastChange("user1", "peer-u1", {
        type: "sync:change",
        files: [],
        peerId: "peer-u1",
        manifestVersion: 1,
      });

      expect(ws2.send).not.toHaveBeenCalled();
    });

    it("continues broadcasting when one peer throws during send", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const throwingWs = mockWs();
      const receiverWs = mockWs();
      throwingWs.send = vi.fn(() => {
        throw new Error("socket closed");
      });

      registry.registerPeer("user1", {
        peerId: "sender",
        hostname: "h1",
        platform: "darwin",
        clientVersion: "0.1.0",
      }, mockWs());
      registry.registerPeer("user1", {
        peerId: "thrower",
        hostname: "h2",
        platform: "linux",
        clientVersion: "0.1.0",
      }, throwingWs);
      registry.registerPeer("user1", {
        peerId: "receiver",
        hostname: "h3",
        platform: "linux",
        clientVersion: "0.1.0",
      }, receiverWs);

      vi.clearAllMocks();

      registry.broadcastChange("user1", "sender", {
        type: "sync:change",
        files: [],
        peerId: "sender",
        manifestVersion: 1,
      });

      expect(throwingWs.send).toHaveBeenCalledOnce();
      expect(receiverWs.send).toHaveBeenCalledOnce();
      expect(warnSpy).toHaveBeenCalledWith(
        "[sync/ws] sendSafe failed:",
        "socket closed",
      );
    });
  });

  describe("bounded peer map (100 max, LRU)", () => {
    it("enforces 100 peer limit per user with LRU eviction", () => {
      const connections: SyncPeerConnection[] = [];

      // Register 100 peers
      for (let i = 0; i < 100; i++) {
        const ws = mockWs();
        connections.push(ws);
        registry.registerPeer("user1", {
          peerId: `peer-${i}`,
          hostname: `host-${i}`,
          platform: "linux",
          clientVersion: "0.1.0",
        }, ws);
      }

      // Register one more -- should evict the oldest (peer-0)
      const ws101 = mockWs();
      registry.registerPeer("user1", {
        peerId: "peer-100",
        hostname: "host-100",
        platform: "linux",
        clientVersion: "0.1.0",
      }, ws101);

      const peers = registry.getPeers("user1");
      expect(peers).toHaveLength(100);
      expect(peers.find((p) => p.peerId === "peer-0")).toBeUndefined();
      expect(peers.find((p) => p.peerId === "peer-100")).toBeDefined();
    });

    it("notifies and closes an evicted peer connection", () => {
      const oldest = mockWs();
      registry.registerPeer("user1", {
        peerId: "peer-0",
        hostname: "host-0",
        platform: "linux",
        clientVersion: "0.1.0",
      }, oldest);

      for (let i = 1; i < 100; i++) {
        registry.registerPeer("user1", {
          peerId: `peer-${i}`,
          hostname: `host-${i}`,
          platform: "linux",
          clientVersion: "0.1.0",
        }, mockWs());
      }

      vi.clearAllMocks();

      registry.registerPeer("user1", {
        peerId: "peer-100",
        hostname: "host-100",
        platform: "linux",
        clientVersion: "0.1.0",
      }, mockWs());

      expect(oldest.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"sync:evicted"'),
      );
      expect(oldest.send).toHaveBeenCalledWith(
        expect.stringContaining('"reason":"peer_limit"'),
      );
      expect(oldest.close).toHaveBeenCalledWith(4000, "sync peer evicted");
    });

    it("different users have independent peer limits", () => {
      for (let i = 0; i < 100; i++) {
        registry.registerPeer("user1", {
          peerId: `peer-${i}`,
          hostname: `h`,
          platform: "linux",
          clientVersion: "0.1.0",
        }, mockWs());
      }

      // user2 should be unaffected
      registry.registerPeer("user2", {
        peerId: "peer-0",
        hostname: "h",
        platform: "linux",
        clientVersion: "0.1.0",
      }, mockWs());

      expect(registry.getPeers("user1")).toHaveLength(100);
      expect(registry.getPeers("user2")).toHaveLength(1);
    });
  });

  describe("bounded user registry", () => {
    it("evicts the oldest user bucket when the outer map cap is exceeded", () => {
      for (let i = 0; i < 10_001; i++) {
        registry.registerPeer(`user-${i}`, {
          peerId: `peer-${i}`,
          hostname: `host-${i}`,
          platform: "linux",
          clientVersion: "0.1.0",
        }, mockWs());
      }

      expect(registry.getPeers("user-0")).toHaveLength(0);
      expect(registry.getPeers("user-10000")).toHaveLength(1);
    });
  });

  describe("getPeers", () => {
    it("returns empty array for unknown user", () => {
      expect(registry.getPeers("unknown")).toEqual([]);
    });

    it("returns registered peers for a user", () => {
      registry.registerPeer("user1", {
        peerId: "p1",
        hostname: "h1",
        platform: "darwin",
        clientVersion: "0.1.0",
      }, mockWs());

      const peers = registry.getPeers("user1");
      expect(peers).toHaveLength(1);
      expect(peers[0]!.peerId).toBe("p1");
    });
  });

  describe("sendToUser", () => {
    it("sends a message to all peers of a user", () => {
      const ws1 = mockWs();
      const ws2 = mockWs();

      registry.registerPeer("user1", {
        peerId: "p1",
        hostname: "h1",
        platform: "darwin",
        clientVersion: "0.1.0",
      }, ws1);

      registry.registerPeer("user1", {
        peerId: "p2",
        hostname: "h2",
        platform: "linux",
        clientVersion: "0.1.0",
      }, ws2);

      vi.clearAllMocks();

      registry.sendToUser("user1", { type: "sync:conflict", path: "f.txt", localHash: "a", remoteHash: "b", remotePeerId: "x", conflictPath: "f (conflict).txt" });

      expect(ws1.send).toHaveBeenCalledOnce();
      expect(ws2.send).toHaveBeenCalledOnce();
    });
  });
});
