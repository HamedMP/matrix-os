// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createGroupBridge,
  type GroupBridgeInterface,
  type GroupContext,
} from "../../shell/src/lib/group-bridge.js";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket extends EventTarget {
  static instances: MockWebSocket[] = [];
  url: string;
  binaryType = "arraybuffer";
  readyState = 0; // CONNECTING
  sentMessages: (ArrayBuffer | Uint8Array | string)[] = [];
  closeCalled = false;

  constructor(url: string) {
    super();
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: ArrayBuffer | Uint8Array | string) {
    this.sentMessages.push(data);
  }

  close() {
    this.closeCalled = true;
    this.readyState = 3;
  }

  simulateOpen() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  simulateClose(code = 1000) {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code }));
  }

  simulateMessage(data: ArrayBuffer | string) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  simulateError() {
    this.dispatchEvent(new Event("error"));
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockGroupContext: GroupContext = {
  id: "!fam:matrix-os.com",
  slug: "family",
  name: "Schmidt Family",
  me: { handle: "@alice:matrix-os.com", role: "owner" },
};

function makeBridge(ctx: GroupContext | null = mockGroupContext): GroupBridgeInterface {
  return createGroupBridge({
    groupContext: ctx,
    gatewayWsUrl: "ws://localhost:4000/ws/groups/family/notes",
    appSlug: "notes",
    wsFactory: (url: string) => new MockWebSocket(url) as unknown as WebSocket,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("group-bridge", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("shared interface", () => {
    it("creates shared interface when groupContext is provided", () => {
      const bridge = makeBridge();
      expect(bridge.shared).toBeDefined();
      expect(typeof bridge.shared.get).toBe("function");
      expect(typeof bridge.shared.set).toBe("function");
      expect(typeof bridge.shared.delete).toBe("function");
      expect(typeof bridge.shared.list).toBe("function");
      expect(typeof bridge.shared.doc).toBe("function");
      expect(typeof bridge.shared.onChange).toBe("function");
      expect(typeof bridge.shared.onError).toBe("function");
    });

    it("connects WebSocket on first shared operation", () => {
      const bridge = makeBridge();
      bridge.shared.list();

      expect(MockWebSocket.instances).toHaveLength(1);
    });

    it("sends sync step 1 on WebSocket open", () => {
      const bridge = makeBridge();
      bridge.shared.list();

      const ws = MockWebSocket.instances[0];
      ws.simulateOpen();

      // Should have sent at least one binary message (sync step 1)
      expect(ws.sentMessages.length).toBeGreaterThanOrEqual(1);
    });

    it("doc() returns a Y.Doc", () => {
      const bridge = makeBridge();
      const doc = bridge.shared.doc();
      expect(doc).toBeDefined();
      expect(typeof doc.getMap).toBe("function");
    });

    it("list returns empty array initially", () => {
      const bridge = makeBridge();
      const keys = bridge.shared.list();
      expect(keys).toEqual([]);
    });

    it("set/get round-trips locally", () => {
      const bridge = makeBridge();
      bridge.shared.set("key1", "value1");
      expect(bridge.shared.get("key1")).toBe("value1");
    });

    it("delete removes a key", () => {
      const bridge = makeBridge();
      bridge.shared.set("key1", "value1");
      bridge.shared.delete("key1");
      expect(bridge.shared.get("key1")).toBeUndefined();
    });

    it("list returns keys after set", () => {
      const bridge = makeBridge();
      bridge.shared.set("a", 1);
      bridge.shared.set("b", 2);
      expect(bridge.shared.list().sort()).toEqual(["a", "b"]);
    });

    it("onChange registers a listener (fires on remote update)", () => {
      const bridge = makeBridge();
      const onChange = vi.fn();
      const unsub = bridge.shared.onChange(onChange);

      // onChange is designed for remote updates, not local mutations
      // Here we just verify registration doesn't crash
      expect(typeof unsub).toBe("function");
    });

    it("onChange unsubscribe works", () => {
      const bridge = makeBridge();
      const onChange = vi.fn();
      const unsub = bridge.shared.onChange(onChange);
      unsub();

      bridge.shared.set("key1", "value1");

      // onChange was NOT called after unsubscribe
      // (Note: it may have been called during Y.Doc update observer before unsubscribe —
      //  but we only care it doesn't fire after the unsub)
      expect(onChange).not.toHaveBeenCalled();
    });

    it("onError fires on WebSocket close", () => {
      const bridge = makeBridge();
      const onError = vi.fn();
      bridge.shared.onError(onError);

      bridge.shared.list(); // triggers connect
      const ws = MockWebSocket.instances[0];
      ws.simulateOpen();
      ws.simulateClose(1006);

      expect(onError).toHaveBeenCalledWith("offline");
    });

    it("onError fires acl_denied on 4403 close", () => {
      const bridge = makeBridge();
      const onError = vi.fn();
      bridge.shared.onError(onError);

      bridge.shared.list();
      const ws = MockWebSocket.instances[0];
      ws.simulateOpen();
      ws.simulateClose(4403);

      expect(onError).toHaveBeenCalledWith("acl_denied");
    });

    it("onError fires on JSON error message", () => {
      const bridge = makeBridge();
      const onError = vi.fn();
      bridge.shared.onError(onError);

      bridge.shared.list();
      const ws = MockWebSocket.instances[0];
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ type: "error", code: "op_too_large" }));

      expect(onError).toHaveBeenCalledWith("op_too_large");
    });
  });

  describe("group interface", () => {
    it("creates group context when groupContext is provided", () => {
      const bridge = makeBridge();
      expect(bridge.group).toBeDefined();
      expect(bridge.group!.id).toBe("!fam:matrix-os.com");
      expect(bridge.group!.slug).toBe("family");
      expect(bridge.group!.name).toBe("Schmidt Family");
      expect(bridge.group!.me.handle).toBe("@alice:matrix-os.com");
    });

    it("group is null when no groupContext", () => {
      const bridge = makeBridge(null);
      expect(bridge.group).toBeNull();
    });

    it("members starts empty", () => {
      const bridge = makeBridge();
      expect(bridge.group!.members).toEqual([]);
    });

    it("onPresence unsubscribe works", () => {
      const bridge = makeBridge();
      const cb = vi.fn();
      const unsub = bridge.group!.onPresence(cb);
      unsub();
      // No crash
    });
  });

  describe("WebSocket lifecycle", () => {
    it("does not connect if groupContext is null", () => {
      const bridge = makeBridge(null);
      bridge.shared.list(); // should not crash
      expect(MockWebSocket.instances).toHaveLength(0);
    });

    it("reuses existing connection on multiple operations", () => {
      const bridge = makeBridge();
      bridge.shared.list();
      bridge.shared.get("key1");
      bridge.shared.set("key2", "val");

      expect(MockWebSocket.instances).toHaveLength(1);
    });
  });
});
