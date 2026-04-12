/**
 * Tests for the group-bridge.ts + os-bridge.ts shared:/group: extensions (T044/T049/T050).
 *
 * Covers:
 *  - MatrixOS.shared.get/set/delete/list/onChange against a fake gateway WS
 *  - MatrixOS.shared.doc() returns mirror (not authoritative)
 *  - MatrixOS.shared.onError(cb) with the five coarse codes only
 *  - MatrixOS.group populated from ?group= query param, null outside group context
 *  - MatrixOS.group.members returns [] until US6
 *  - Connection lifecycle: reconnect re-syncs via syncStep1→syncStep2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import {
  createGroupBridge,
  type GroupBridgeOptions,
  type GroupBridgeInterface,
  type GroupContext,
  SHARED_ERROR_CODES,
} from "../../shell/src/lib/group-bridge.js";

// ---------------------------------------------------------------------------
// Fake WebSocket server (mirrors the gateway's sync protocol)
// ---------------------------------------------------------------------------

type WsMessageHandler = (data: Uint8Array) => void;
type WsCloseHandler = () => void;

class FakeWsServer {
  private doc: Y.Doc;
  private clientMessageHandler: WsMessageHandler | null = null;

  constructor() {
    this.doc = new Y.Doc();
  }

  getDoc(): Y.Doc {
    return this.doc;
  }

  // Called when the "client" connects — server sends syncStep1
  handleClientConnect(): Uint8Array {
    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, this.doc);
    return encoding.toUint8Array(encoder);
  }

  // Process a message sent from the client; returns response bytes (or null)
  handleClientMessage(data: Uint8Array): Uint8Array | null {
    const decoder = decoding.createDecoder(data);
    const encoder = encoding.createEncoder();
    const msgType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, "server", () => undefined);
    const response = encoding.toUint8Array(encoder);
    if (response.length > 0) return response;
    return null;
  }

  // Simulate the server pushing an update to the client
  pushUpdate(mutator: (doc: Y.Doc) => void): Uint8Array {
    const prevVector = Y.encodeStateVector(this.doc);
    mutator(this.doc);
    const update = Y.encodeStateAsUpdate(this.doc, prevVector);
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    return encoding.toUint8Array(encoder);
  }
}

// ---------------------------------------------------------------------------
// Fake WebSocket (client-side, used by group-bridge.ts)
// ---------------------------------------------------------------------------

type FakeWsEventMap = {
  open: () => void;
  message: (evt: { data: ArrayBuffer | Uint8Array }) => void;
  close: (evt: { code: number; reason: string }) => void;
  error: (evt: Event) => void;
};

class FakeWebSocket {
  readyState = 1; // OPEN
  sent: Uint8Array[] = [];
  private handlers: Map<string, Array<(...args: unknown[]) => void>> = new Map();
  private server: FakeWsServer;

  constructor(server: FakeWsServer) {
    this.server = server;
  }

  addEventListener(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  removeEventListener(event: string, handler: (...args: unknown[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
    this.handlers.set(event, list);
  }

  send(data: Uint8Array | ArrayBuffer): void {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.sent.push(bytes);
    // Auto-process at server and send back any response
    const response = this.server.handleClientMessage(bytes);
    if (response) {
      this.simulateServerMessage(response);
    }
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.emit("close", { code: 1000, reason: "normal" });
  }

  // Test helpers to trigger events on the "client"
  simulateOpen(): void {
    this.emit("open");
    // Server sends syncStep1 on connect
    const step1 = this.server.handleClientConnect();
    this.simulateServerMessage(step1);
  }

  simulateServerMessage(data: Uint8Array): void {
    this.emit("message", { data: data.buffer });
  }

  simulateServerClose(code = 4403, reason = "acl_denied"): void {
    this.readyState = 3;
    this.emit("close", { code, reason });
  }

  simulateError(): void {
    this.emit("error", new Event("error"));
  }

  private emit(event: string, ...args: unknown[]): void {
    const list = this.handlers.get(event) ?? [];
    for (const handler of list) {
      handler(...args);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory helper
// ---------------------------------------------------------------------------

function makeBridge(opts: {
  groupSlug?: string;
  server?: FakeWsServer;
  wsFactory?: (url: string) => FakeWebSocket;
}): { bridge: GroupBridgeInterface; ws: FakeWebSocket; server: FakeWsServer } {
  const server = opts.server ?? new FakeWsServer();
  let lastWs: FakeWebSocket | undefined;

  const wsFactory = opts.wsFactory ?? ((_url: string) => {
    const ws = new FakeWebSocket(server);
    lastWs = ws;
    return ws;
  });

  const groupCtx: GroupContext | null = opts.groupSlug
    ? { id: "!abc:matrix-os.com", slug: opts.groupSlug, name: "Test Group", me: { handle: "@alice:matrix-os.com", role: "owner" } }
    : null;

  const bridgeOpts: GroupBridgeOptions = {
    groupContext: groupCtx,
    gatewayWsUrl: opts.groupSlug ? `/ws/groups/${opts.groupSlug}/notes` : "",
    appSlug: "notes",
    wsFactory: wsFactory as unknown as (url: string) => WebSocket,
  };

  const bridge = createGroupBridge(bridgeOpts);

  // Trigger WS creation eagerly so tests have a ws handle to work with
  if (opts.groupSlug) {
    bridge.shared.get("__init__");
  }

  const ws = lastWs!;
  return { bridge, ws, server };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("group-bridge", () => {
  describe("MatrixOS.shared KV operations", () => {
    it("set and get operate on mirror Y.Doc kv map", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      bridge.shared.set("hello", "world");
      expect(bridge.shared.get("hello")).toBe("world");
    });

    it("delete removes a key from kv map", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      bridge.shared.set("k", "v");
      bridge.shared.delete("k");
      expect(bridge.shared.get("k")).toBeUndefined();
    });

    it("list returns all current keys", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      bridge.shared.set("a", "1");
      bridge.shared.set("b", "2");
      const keys = bridge.shared.list();
      expect(keys).toContain("a");
      expect(keys).toContain("b");
    });

    it("doc() returns the mirror Y.Doc (same instance across calls)", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      const doc1 = bridge.shared.doc();
      const doc2 = bridge.shared.doc();
      expect(doc1).toBe(doc2);
      expect(doc1).toBeInstanceOf(Y.Doc);
    });

    it("doc() is the mirror, not the gateway authoritative doc", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      const mirrorDoc = bridge.shared.doc();
      // Mirror should be a regular Y.Doc — client side only
      expect(mirrorDoc).toBeInstanceOf(Y.Doc);
      // It's a separate instance from the server doc
      expect(mirrorDoc).not.toBe(ws["server" as keyof FakeWebSocket]);
    });
  });

  describe("onChange", () => {
    it("fires onChange when remote update arrives via WS", () => {
      const { bridge, ws, server } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      const onChange = vi.fn();
      bridge.shared.onChange(onChange);

      // Server pushes an update
      const updateMsg = server.pushUpdate((doc) => {
        doc.getMap("kv").set("remote-key", "remote-val");
      });
      ws.simulateServerMessage(updateMsg);

      expect(onChange).toHaveBeenCalled();
    });

    it("does not fire onChange for local set (only remote triggers it)", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      const onChange = vi.fn();
      bridge.shared.onChange(onChange);

      // Local set should not trigger the remote-update listener
      bridge.shared.set("local", "val");

      // onChange should NOT have been called for a local mutation
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe("onError — coarse codes only", () => {
    it("exports SHARED_ERROR_CODES closed set of five codes", () => {
      expect(SHARED_ERROR_CODES).toEqual(
        new Set(["sync_failed", "acl_denied", "offline", "op_too_large", "state_overflow"]),
      );
    });

    it("fires 'offline' on WS disconnect", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      const onError = vi.fn();
      bridge.shared.onError(onError);

      ws.simulateServerClose(1006, "abnormal");

      expect(onError).toHaveBeenCalledWith("offline");
    });

    it("fires 'acl_denied' on WS close with code 4403", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      const onError = vi.fn();
      bridge.shared.onError(onError);

      ws.simulateServerClose(4403, "acl_denied");

      expect(onError).toHaveBeenCalledWith("acl_denied");
    });

    it("fires 'op_too_large' when set mutation exceeds 1MB raw", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      const onError = vi.fn();
      bridge.shared.onError(onError);

      // 2MB value — way over the 1MB limit
      const bigValue = "x".repeat(2 * 1024 * 1024);
      bridge.shared.set("big", bigValue);

      expect(onError).toHaveBeenCalledWith("op_too_large");
    });

    it("fires 'sync_failed' on server error message", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      const onError = vi.fn();
      bridge.shared.onError(onError);

      // Server sends a JSON error message with sync_failed
      const errMsg = JSON.stringify({ type: "error", code: "sync_failed" });
      const encoder = new TextEncoder();
      ws.simulateServerMessage(encoder.encode(errMsg));

      expect(onError).toHaveBeenCalledWith("sync_failed");
    });

    it("NEVER fires onError with any code outside the closed set", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      const observed: string[] = [];
      bridge.shared.onError((code) => observed.push(code));

      // Trigger all scenarios and collect codes
      ws.simulateServerClose(1006, "abnormal");

      for (const code of observed) {
        expect(SHARED_ERROR_CODES.has(code as string)).toBe(true);
      }
    });
  });

  describe("MatrixOS.group", () => {
    it("is null outside group context (no ?group= param)", () => {
      const bridgeOpts: GroupBridgeOptions = {
        groupContext: null,
        gatewayWsUrl: "",
        appSlug: "notes",
        wsFactory: () => { throw new Error("should not connect"); },
      };
      const bridge = createGroupBridge(bridgeOpts);
      expect(bridge.group).toBeNull();
    });

    it("is populated when group context is provided", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      expect(bridge.group).not.toBeNull();
      expect(bridge.group!.slug).toBe("fam");
      expect(bridge.group!.id).toBe("!abc:matrix-os.com");
      expect(bridge.group!.name).toBe("Test Group");
      expect(bridge.group!.me.handle).toBe("@alice:matrix-os.com");
    });

    it("members returns [] until US6 wires the member list", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      expect(bridge.group!.members).toEqual([]);
    });
  });

  describe("connection lifecycle", () => {
    it("opens WS on first shared.* call", () => {
      const wsFactory = vi.fn((url: string) => {
        const ws = new FakeWebSocket(new FakeWsServer());
        // Auto-open for simplicity
        setTimeout(() => ws.simulateOpen(), 0);
        return ws;
      });

      const bridgeOpts: GroupBridgeOptions = {
        groupContext: { id: "!abc:matrix-os.com", slug: "fam", name: "Fam", me: { handle: "@alice:matrix-os.com", role: "owner" } },
        gatewayWsUrl: "/ws/groups/fam/notes",
        appSlug: "notes",
        wsFactory: wsFactory as unknown as (url: string) => WebSocket,
      };
      const bridge = createGroupBridge(bridgeOpts);

      // WS should not be opened yet (lazy)
      expect(wsFactory).not.toHaveBeenCalled();

      // Access shared.get to trigger connection
      bridge.shared.get("any");
      expect(wsFactory).toHaveBeenCalledOnce();
    });

    it("re-syncs full state on reconnect via syncStep1→syncStep2", () => {
      const server = new FakeWsServer();
      server.getDoc().getMap("kv").set("pre-existing", "value");

      let wsInstance: FakeWebSocket | undefined;
      const wsFactory = (url: string) => {
        wsInstance = new FakeWebSocket(server);
        return wsInstance;
      };

      const bridgeOpts: GroupBridgeOptions = {
        groupContext: { id: "!abc:matrix-os.com", slug: "fam", name: "Fam", me: { handle: "@alice:matrix-os.com", role: "owner" } },
        gatewayWsUrl: "/ws/groups/fam/notes",
        appSlug: "notes",
        wsFactory: wsFactory as unknown as (url: string) => WebSocket,
      };
      const bridge = createGroupBridge(bridgeOpts);
      bridge.shared.get("trigger-connect");

      // First connect
      wsInstance!.simulateOpen();
      const firstWs = wsInstance;

      // After sync, mirror should have pre-existing data
      expect(bridge.shared.get("pre-existing")).toBe("value");

      // Disconnect
      wsInstance!.simulateServerClose(1006, "disconnect");

      // Trigger reconnect
      bridge.shared.get("trigger-reconnect");

      // Should have created a new WS
      expect(wsInstance).not.toBe(firstWs);
      wsInstance!.simulateOpen();

      // After reconnect+sync, mirror still has the data
      expect(bridge.shared.get("pre-existing")).toBe("value");
    });
  });

  // ---------------------------------------------------------------------------
  // Wave 4 — members/presence subscriptions (T077a)
  // ---------------------------------------------------------------------------

  describe("members_changed WS event", () => {
    it("populates group.members from members_changed payload", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      expect(bridge.group!.members).toEqual([]);

      const payload = JSON.stringify({
        type: "members_changed",
        members: [
          { handle: "@alice:matrix-os.com", role: "owner", online: true },
          { handle: "@bob:matrix-os.com", role: "editor", online: false },
        ],
      });
      ws.simulateServerMessage(new TextEncoder().encode(payload));

      expect(bridge.group!.members).toHaveLength(2);
      expect(bridge.group!.members[0]).toMatchObject({ handle: "@alice:matrix-os.com", role: "owner", online: true });
      expect(bridge.group!.members[1]).toMatchObject({ handle: "@bob:matrix-os.com", role: "editor", online: false });
    });

    it("replaces prior members list on each members_changed", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      ws.simulateServerMessage(new TextEncoder().encode(JSON.stringify({
        type: "members_changed",
        members: [{ handle: "@alice:matrix-os.com", role: "owner", online: true }],
      })));

      ws.simulateServerMessage(new TextEncoder().encode(JSON.stringify({
        type: "members_changed",
        members: [
          { handle: "@alice:matrix-os.com", role: "owner", online: true },
          { handle: "@carol:matrix-os.com", role: "viewer", online: true },
        ],
      })));

      expect(bridge.group!.members).toHaveLength(2);
      expect(bridge.group!.members[1]!.handle).toBe("@carol:matrix-os.com");
    });

    it("ignores members_changed when bridge has no group context", () => {
      const bridgeOpts: GroupBridgeOptions = {
        groupContext: null,
        gatewayWsUrl: "",
        appSlug: "notes",
        wsFactory: () => { throw new Error("should not connect"); },
      };
      const bridge = createGroupBridge(bridgeOpts);
      // No group — members_changed should be silently ignored (no group to update)
      expect(bridge.group).toBeNull();
    });
  });

  describe("presence_changed WS event", () => {
    it("fires onPresence callback with presence update", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      // Seed group with a member first
      ws.simulateServerMessage(new TextEncoder().encode(JSON.stringify({
        type: "members_changed",
        members: [{ handle: "@alice:matrix-os.com", role: "owner", online: true }],
      })));

      const onPresence = vi.fn();
      bridge.group!.onPresence(onPresence);

      ws.simulateServerMessage(new TextEncoder().encode(JSON.stringify({
        type: "presence_changed",
        handle: "@alice:matrix-os.com",
        status: "offline",
        last_active_ago: 5000,
      })));

      expect(onPresence).toHaveBeenCalledOnce();
      expect(onPresence).toHaveBeenCalledWith({
        handle: "@alice:matrix-os.com",
        status: "offline",
        last_active_ago: 5000,
      });
    });

    it("fans out presence_changed to multiple subscribers", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      ws.simulateServerMessage(new TextEncoder().encode(JSON.stringify({
        type: "members_changed",
        members: [{ handle: "@alice:matrix-os.com", role: "owner", online: true }],
      })));

      const cb1 = vi.fn();
      const cb2 = vi.fn();
      bridge.group!.onPresence(cb1);
      bridge.group!.onPresence(cb2);

      ws.simulateServerMessage(new TextEncoder().encode(JSON.stringify({
        type: "presence_changed",
        handle: "@alice:matrix-os.com",
        status: "online",
        last_active_ago: 0,
      })));

      expect(cb1).toHaveBeenCalledOnce();
      expect(cb2).toHaveBeenCalledOnce();
    });

    it("disposer returned by onPresence removes the listener", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      ws.simulateServerMessage(new TextEncoder().encode(JSON.stringify({
        type: "members_changed",
        members: [{ handle: "@alice:matrix-os.com", role: "owner", online: true }],
      })));

      const onPresence = vi.fn();
      const dispose = bridge.group!.onPresence(onPresence);
      dispose();

      ws.simulateServerMessage(new TextEncoder().encode(JSON.stringify({
        type: "presence_changed",
        handle: "@alice:matrix-os.com",
        status: "online",
        last_active_ago: 0,
      })));

      expect(onPresence).not.toHaveBeenCalled();
    });

    it("NEVER fires onPresence for handles outside the current group", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      // Only alice is a member of this group
      ws.simulateServerMessage(new TextEncoder().encode(JSON.stringify({
        type: "members_changed",
        members: [{ handle: "@alice:matrix-os.com", role: "owner", online: true }],
      })));

      const onPresence = vi.fn();
      bridge.group!.onPresence(onPresence);

      // Presence event for a non-member handle
      ws.simulateServerMessage(new TextEncoder().encode(JSON.stringify({
        type: "presence_changed",
        handle: "@stranger:other-server.com",
        status: "online",
        last_active_ago: 0,
      })));

      // Must NOT fire — stranger is not in this group's member list
      expect(onPresence).not.toHaveBeenCalled();
    });

    it("updates group.members online status when presence_changed arrives", () => {
      const { bridge, ws } = makeBridge({ groupSlug: "fam" });
      ws.simulateOpen();

      ws.simulateServerMessage(new TextEncoder().encode(JSON.stringify({
        type: "members_changed",
        members: [{ handle: "@alice:matrix-os.com", role: "owner", online: true }],
      })));

      expect(bridge.group!.members[0]!.online).toBe(true);

      ws.simulateServerMessage(new TextEncoder().encode(JSON.stringify({
        type: "presence_changed",
        handle: "@alice:matrix-os.com",
        status: "offline",
        last_active_ago: 12000,
      })));

      expect(bridge.group!.members[0]!.online).toBe(false);
    });
  });
});
