import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import {
  createGroupWsHandler,
  type GroupWsHandlerOptions,
  type GroupWsGroupSync,
  type GroupWsGroupRegistry,
  type GroupWsMemberEntry,
  type GroupWsPresenceEntry,
} from "../../packages/gateway/src/group-ws.js";

// ---------------------------------------------------------------------------
// Fake GroupSync
// ---------------------------------------------------------------------------

class FakeGroupSync implements GroupWsGroupSync {
  private doc: Y.Doc;
  private listeners = new Set<(update: Uint8Array, origin: unknown) => void>();
  private membersListeners = new Set<(members: GroupWsMemberEntry[]) => void>();
  private presenceListeners = new Set<(handle: string, entry: GroupWsPresenceEntry) => void>();
  private members: GroupWsMemberEntry[] = [];
  private presence: Record<string, GroupWsPresenceEntry> = {};

  constructor() {
    this.doc = new Y.Doc();
  }

  getDoc(_appSlug: string): Y.Doc {
    return this.doc;
  }

  onChange(
    _appSlug: string,
    listener: (info: { appSlug: string; origin: "local" | "remote"; eventId: string | null; sender: string | null }) => void,
  ): { dispose(): void } {
    const docObserver = (update: Uint8Array, origin: unknown) => {
      this.listeners.forEach((l) => l(update, origin));
      listener({ appSlug: _appSlug, origin: origin === "local" ? "local" : "remote", eventId: null, sender: null });
    };
    this.doc.on("update", docObserver);
    return {
      dispose: () => {
        this.doc.off("update", docObserver);
      },
    };
  }

  async applyLocalMutation(appSlug: string, mutator: (doc: Y.Doc) => void): Promise<void> {
    mutator(this.doc);
  }

  getMembers(): GroupWsMemberEntry[] {
    return [...this.members];
  }

  getPresence(): Record<string, GroupWsPresenceEntry> {
    return { ...this.presence };
  }

  onMembersChanged(cb: (members: GroupWsMemberEntry[]) => void): { dispose(): void } {
    this.membersListeners.add(cb);
    return { dispose: () => this.membersListeners.delete(cb) };
  }

  onPresenceChanged(cb: (handle: string, entry: GroupWsPresenceEntry) => void): { dispose(): void } {
    this.presenceListeners.add(cb);
    return { dispose: () => this.presenceListeners.delete(cb) };
  }

  // Test helpers
  applyRemoteUpdate(update: Uint8Array): void {
    Y.applyUpdate(this.doc, update, "remote");
  }

  simulateMembersChanged(members: GroupWsMemberEntry[]): void {
    this.members = members;
    for (const cb of this.membersListeners) cb([...members]);
  }

  simulatePresenceChanged(handle: string, entry: GroupWsPresenceEntry): void {
    this.presence[handle] = entry;
    for (const cb of this.presenceListeners) cb(handle, { ...entry });
  }

  setInitialMembers(members: GroupWsMemberEntry[]): void {
    this.members = members;
  }

  setInitialPresence(presence: Record<string, GroupWsPresenceEntry>): void {
    this.presence = presence;
  }
}

// ---------------------------------------------------------------------------
// Fake GroupRegistry
// ---------------------------------------------------------------------------

class FakeGroupRegistry implements GroupWsGroupRegistry {
  private groups = new Map<string, { roomId: string; readPl: number; writePl: number }>();
  private syncs = new Map<string, FakeGroupSync>();

  addGroup(slug: string, opts: { roomId: string; readPl?: number; writePl?: number }): FakeGroupSync {
    this.groups.set(slug, { roomId: opts.roomId, readPl: opts.readPl ?? 0, writePl: opts.writePl ?? 0 });
    const sync = new FakeGroupSync();
    this.syncs.set(slug, sync);
    return sync;
  }

  get(slug: string): { room_id: string } | null {
    const g = this.groups.get(slug);
    return g ? { room_id: g.roomId } : null;
  }

  getSyncHandle(slug: string): FakeGroupSync | null {
    return this.syncs.get(slug) ?? null;
  }

  getAcl(_slug: string, _appSlug: string): { read_pl: number; write_pl: number } | null {
    const g = this.groups.get(_slug);
    if (!g) return null;
    return { read_pl: g.readPl, write_pl: g.writePl };
  }

  getMemberPowerLevel(_slug: string, _userHandle: string): number {
    return 100; // default: owner-level
  }

  // Test helper: update ACL to simulate downgrade
  setAcl(slug: string, readPl: number, writePl: number): void {
    const g = this.groups.get(slug);
    if (g) {
      g.readPl = readPl;
      g.writePl = writePl;
    }
  }

  setMemberPowerLevel(slug: string, userHandle: string, pl: number): void {
    // per-member override stored for testing — use a map
    (this as unknown as { _plOverrides: Map<string, number> })._plOverrides ??= new Map();
    (this as unknown as { _plOverrides: Map<string, number> })._plOverrides.set(`${slug}:${userHandle}`, pl);
  }
}

// ---------------------------------------------------------------------------
// Fake auth verifier
// ---------------------------------------------------------------------------

function makeAuthVerifier(validToken: string, userHandle: string) {
  return async (token: string): Promise<string | null> => {
    if (token === validToken) return userHandle;
    return null;
  };
}

// ---------------------------------------------------------------------------
// Helper: build a syncStep1 message buffer from a Y.Doc
// ---------------------------------------------------------------------------

function buildSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

function buildUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

// ---------------------------------------------------------------------------
// Fake WebSocket
// ---------------------------------------------------------------------------

interface FakeWsMessage {
  data: Uint8Array | string;
}

class FakeWebSocket {
  sent: Array<Uint8Array | string> = [];
  closedCode: number | undefined;
  closedReason: string | undefined;
  closed = false;

  send(data: Uint8Array | string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closedCode = code;
    this.closedReason = reason;
  }

  sentBinary(): Uint8Array[] {
    return this.sent.filter((m): m is Uint8Array => m instanceof Uint8Array);
  }

  sentText(): string[] {
    return this.sent.filter((m): m is string => typeof m === "string");
  }

  parseSentErrors(): Array<{ type: string; code: string }> {
    return this.sentText()
      .map((t) => {
        try { return JSON.parse(t); } catch { return null; }
      })
      .filter((m): m is { type: string; code: string } => Boolean(m) && (m as { type?: string }).type === "error");
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createGroupWsHandler", () => {
  let registry: FakeGroupRegistry;
  let options: GroupWsHandlerOptions;

  beforeEach(() => {
    registry = new FakeGroupRegistry();
    options = {
      groupRegistry: registry,
      verifyToken: makeAuthVerifier("valid-token", "@alice:matrix-os.com"),
    };
  });

  describe("upgrade auth", () => {
    it("returns 401 when no bearer token provided", async () => {
      const handler = createGroupWsHandler(options);
      registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      const result = await handler.handleUpgrade("fam", "notes", null);
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/unauthorized/i);
    });

    it("returns 401 when bearer token is invalid", async () => {
      const handler = createGroupWsHandler(options);
      registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      const result = await handler.handleUpgrade("fam", "notes", "bad-token");
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/unauthorized/i);
    });

    it("returns 403 when group not found (non-member)", async () => {
      const handler = createGroupWsHandler(options);
      // No group registered for "fam"

      const result = await handler.handleUpgrade("fam", "notes", "valid-token");
      expect(result.status).toBe(403);
    });

    it("returns 4403 when user power level below read_pl", async () => {
      const handler = createGroupWsHandler(options);
      registry.addGroup("restricted", { roomId: "!abc:matrix-os.com", readPl: 50, writePl: 50 });

      // Override: alice has PL=0, read_pl=50
      const registryWithLowPl = new FakeGroupRegistry();
      const opts2: GroupWsHandlerOptions = {
        groupRegistry: {
          get: (slug) => registryWithLowPl.get(slug) ?? registry.get(slug),
          getSyncHandle: (slug) => registry.getSyncHandle(slug),
          getAcl: () => ({ read_pl: 50, write_pl: 50 }),
          getMemberPowerLevel: () => 0,
        },
        verifyToken: makeAuthVerifier("valid-token", "@alice:matrix-os.com"),
      };
      registryWithLowPl.addGroup("restricted", { roomId: "!abc:matrix-os.com", readPl: 50 });

      const handler2 = createGroupWsHandler(opts2);
      const result = await handler2.handleUpgrade("restricted", "notes", "valid-token");
      expect(result.status).toBe(4403);
      expect(result.error).toMatch(/acl/i);
    });

    it("returns 200 ok when auth and ACL pass", async () => {
      const handler = createGroupWsHandler(options);
      registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      const result = await handler.handleUpgrade("fam", "notes", "valid-token");
      expect(result.status).toBe(200);
    });
  });

  describe("Yjs sync handshake", () => {
    it("sends syncStep1 from server doc state on connect", async () => {
      const handler = createGroupWsHandler(options);
      const groupSync = registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      // Write something to the doc so state vector is non-trivial
      const doc = groupSync.getDoc("notes");
      doc.getMap("kv").set("foo", "bar");

      const ws = new FakeWebSocket();
      const conn = await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws as unknown as WebSocket);
      expect(conn).not.toBeNull();

      // Server should have sent a binary syncStep1 message
      const binaryMsgs = ws.sentBinary();
      expect(binaryMsgs.length).toBeGreaterThanOrEqual(1);

      // First message should decode as syncStep1
      const firstMsg = binaryMsgs[0]!;
      const decoder = decoding.createDecoder(firstMsg);
      const msgType = decoding.readVarUint(decoder);
      expect(msgType).toBe(syncProtocol.messageYjsSyncStep1);
    });

    it("applies syncStep2 from client containing missing updates", async () => {
      const handler = createGroupWsHandler(options);
      const groupSync = registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      const ws = new FakeWebSocket();
      const conn = await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws as unknown as WebSocket);
      expect(conn).not.toBeNull();

      // Build a client-side doc with an extra key
      const clientDoc = new Y.Doc();
      clientDoc.getMap("kv").set("client-key", "client-val");

      // Simulate client sending syncStep2 in response (full state as update)
      const clientUpdate = Y.encodeStateAsUpdate(clientDoc);
      const encoder = encoding.createEncoder();
      syncProtocol.writeSyncStep2(encoder, clientDoc);
      const syncStep2Msg = encoding.toUint8Array(encoder);

      const applyMutationSpy = vi.spyOn(groupSync as unknown as FakeGroupSync, "applyLocalMutation");
      conn!.onMessage(syncStep2Msg);
      await vi.waitFor(() => expect(applyMutationSpy).toHaveBeenCalled());
    });

    it("handles inbound update message and routes to applyLocalMutation", async () => {
      const handler = createGroupWsHandler(options);
      const groupSync = registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      const ws = new FakeWebSocket();
      const conn = await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws as unknown as WebSocket);

      const clientDoc = new Y.Doc();
      clientDoc.getMap("kv").set("k", "v");
      const update = Y.encodeStateAsUpdate(clientDoc);

      const updateMsg = buildUpdate(update);
      const applyMutationSpy = vi.spyOn(groupSync as unknown as FakeGroupSync, "applyLocalMutation");
      conn!.onMessage(updateMsg);
      await vi.waitFor(() => expect(applyMutationSpy).toHaveBeenCalled());
    });

    it("fans out gateway doc updates to connected sockets as update messages", async () => {
      const handler = createGroupWsHandler(options);
      const groupSync = registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      const ws = new FakeWebSocket();
      await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws as unknown as WebSocket);

      const initialCount = ws.sentBinary().length;

      // Simulate remote update arriving in the group doc
      const remoteDoc = new Y.Doc();
      remoteDoc.getMap("kv").set("remote", "value");
      const remoteUpdate = Y.encodeStateAsUpdate(remoteDoc);
      groupSync.applyRemoteUpdate(remoteUpdate);

      // Should have received a new binary update message
      await vi.waitFor(() => expect(ws.sentBinary().length).toBeGreaterThan(initialCount));

      // The last message should be a Yjs update type
      const lastMsg = ws.sentBinary().at(-1)!;
      const decoder = decoding.createDecoder(lastMsg);
      const msgType = decoding.readVarUint(decoder);
      expect(msgType).toBe(syncProtocol.messageYjsUpdate);
    });
  });

  describe("per-connection isolation", () => {
    it("does not share state buffers between connections", async () => {
      const handler = createGroupWsHandler(options);
      registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      const ws1 = new FakeWebSocket();
      const ws2 = new FakeWebSocket();

      await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws1 as unknown as WebSocket);
      await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws2 as unknown as WebSocket);

      // Each connection has its own syncStep1
      expect(ws1.sentBinary().length).toBeGreaterThanOrEqual(1);
      expect(ws2.sentBinary().length).toBeGreaterThanOrEqual(1);
    });

    it("removes socket from subscriber set on close", async () => {
      const handler = createGroupWsHandler(options);
      const groupSync = registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      const ws = new FakeWebSocket();
      const conn = await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws as unknown as WebSocket);
      conn!.onClose();

      const countBefore = ws.sentBinary().length;

      // After close, updates should not arrive
      const remoteDoc = new Y.Doc();
      remoteDoc.getMap("kv").set("k", "v");
      groupSync.applyRemoteUpdate(Y.encodeStateAsUpdate(remoteDoc));

      // brief wait — no new messages should arrive
      await new Promise((r) => setTimeout(r, 10));
      expect(ws.sentBinary().length).toBe(countBefore);
    });
  });

  describe("ACL downgrade mid-connection", () => {
    it("closes socket with code 4403 when ACL drops below read_pl on inbound update", async () => {
      let currentReadPl = 0;
      const dynamicRegistry: GroupWsGroupRegistry = {
        get: () => ({ room_id: "!abc:matrix-os.com" }),
        getSyncHandle: (slug) => registry.getSyncHandle(slug),
        getAcl: () => ({ read_pl: currentReadPl, write_pl: 0 }),
        getMemberPowerLevel: () => 0,
      };
      registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      const handler = createGroupWsHandler({
        groupRegistry: dynamicRegistry,
        verifyToken: makeAuthVerifier("valid-token", "@alice:matrix-os.com"),
      });

      const ws = new FakeWebSocket();
      const conn = await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws as unknown as WebSocket);
      expect(conn).not.toBeNull();

      // Downgrade ACL so alice's PL (0) is now below read_pl (50)
      currentReadPl = 50;

      // Send an update — handler should re-check ACL and close
      const clientDoc = new Y.Doc();
      const updateMsg = buildUpdate(Y.encodeStateAsUpdate(clientDoc));
      conn!.onMessage(updateMsg);

      await vi.waitFor(() => expect(ws.closed).toBe(true));
      expect(ws.closedCode).toBe(4403);

      // Should also have sent an error payload before closing
      const errors = ws.parseSentErrors();
      expect(errors.some((e) => e.code === "acl_denied")).toBe(true);
    });
  });

  describe("error code mapping", () => {
    it("maps internal errors to coarse codes — never leaks gateway details to client", async () => {
      const handler = createGroupWsHandler(options);
      const groupSync = registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      // Make applyLocalMutation throw
      vi.spyOn(groupSync as unknown as FakeGroupSync, "applyLocalMutation").mockRejectedValue(
        new Error("Internal gateway error: postgres connection refused"),
      );

      const ws = new FakeWebSocket();
      const conn = await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws as unknown as WebSocket);

      const clientDoc = new Y.Doc();
      conn!.onMessage(buildUpdate(Y.encodeStateAsUpdate(clientDoc)));

      await vi.waitFor(() => ws.sentText().length > 0);

      const errors = ws.parseSentErrors();
      expect(errors.length).toBeGreaterThan(0);

      // Must use only closed-set codes
      const VALID_CODES = new Set(["sync_failed", "acl_denied", "offline", "op_too_large", "state_overflow"]);
      for (const err of errors) {
        expect(VALID_CODES.has(err.code)).toBe(true);
        // Must NOT leak internal error text
        const raw = JSON.stringify(err);
        expect(raw).not.toContain("postgres");
        expect(raw).not.toContain("connection refused");
      }
    });
  });

  describe("members/presence WS greeting and fan-out", () => {
    it("sends members_changed greeting on connect with initial member list", async () => {
      const handler = createGroupWsHandler(options);
      const groupSync = registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });
      groupSync.setInitialMembers([
        { handle: "@alice:matrix-os.com", role: "owner", membership: "join" },
      ]);

      const ws = new FakeWebSocket();
      await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws as unknown as WebSocket);

      const textMsgs = ws.sentText().map((t) => JSON.parse(t));
      const greeting = textMsgs.find((m) => m.type === "members_changed");
      expect(greeting).toBeDefined();
      expect(greeting.members).toHaveLength(1);
      expect(greeting.members[0].handle).toBe("@alice:matrix-os.com");
    });

    it("sends presence_snapshot greeting on connect", async () => {
      const handler = createGroupWsHandler(options);
      const groupSync = registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });
      groupSync.setInitialPresence({
        "@alice:matrix-os.com": { handle: "@alice:matrix-os.com", status: "online" },
      });

      const ws = new FakeWebSocket();
      await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws as unknown as WebSocket);

      const textMsgs = ws.sentText().map((t) => JSON.parse(t));
      const snapshot = textMsgs.find((m) => m.type === "presence_snapshot");
      expect(snapshot).toBeDefined();
      expect(snapshot.presence["@alice:matrix-os.com"].status).toBe("online");
    });

    it("fans out members_changed to connected sockets when membership changes", async () => {
      const handler = createGroupWsHandler(options);
      const groupSync = registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      const ws = new FakeWebSocket();
      await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws as unknown as WebSocket);

      const before = ws.sentText().length;

      groupSync.simulateMembersChanged([
        { handle: "@alice:matrix-os.com", role: "owner", membership: "join" },
        { handle: "@bob:matrix-os.com", role: "editor", membership: "join" },
      ]);

      const newMsgs = ws.sentText().slice(before).map((t) => JSON.parse(t));
      const update = newMsgs.find((m) => m.type === "members_changed");
      expect(update).toBeDefined();
      expect(update.members).toHaveLength(2);
    });

    it("fans out presence_changed per-handle when presence updates", async () => {
      const handler = createGroupWsHandler(options);
      const groupSync = registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      const ws = new FakeWebSocket();
      await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws as unknown as WebSocket);

      const before = ws.sentText().length;

      groupSync.simulatePresenceChanged("@alice:matrix-os.com", {
        handle: "@alice:matrix-os.com",
        status: "offline",
        last_active_ago: 3000,
      });

      const newMsgs = ws.sentText().slice(before).map((t) => JSON.parse(t));
      const update = newMsgs.find((m) => m.type === "presence_changed");
      expect(update).toBeDefined();
      expect(update.handle).toBe("@alice:matrix-os.com");
      expect(update.status).toBe("offline");
    });

    it("stops fan-out after onClose disposes subscriptions", async () => {
      const handler = createGroupWsHandler(options);
      const groupSync = registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      const ws = new FakeWebSocket();
      const conn = await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws as unknown as WebSocket);
      conn!.onClose();

      const before = ws.sentText().length;
      groupSync.simulateMembersChanged([{ handle: "@alice:matrix-os.com", role: "owner", membership: "join" }]);
      groupSync.simulatePresenceChanged("@alice:matrix-os.com", { handle: "@alice:matrix-os.com", status: "online" });

      // No new text messages after close
      expect(ws.sentText().length).toBe(before);
    });
  });

  describe("subscriber registry size cap", () => {
    it("closes oldest connection when per-app subscriber set exceeds cap", async () => {
      const handler = createGroupWsHandler({
        ...options,
        maxSocketsPerApp: 3,
      });
      registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      const sockets: FakeWebSocket[] = [];
      for (let i = 0; i < 3; i++) {
        const ws = new FakeWebSocket();
        sockets.push(ws);
        await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws as unknown as WebSocket);
      }

      // All 3 open; cap is 3. Adding a 4th triggers drop-oldest
      const wsNew = new FakeWebSocket();
      await handler.openConnection("fam", "notes", "@alice:matrix-os.com", wsNew as unknown as WebSocket);

      // The oldest socket should have been closed
      expect(sockets[0]!.closed).toBe(true);
    });

    it("evicted connection does not receive further doc updates (changeSub disposed)", async () => {
      const handler = createGroupWsHandler({
        ...options,
        maxSocketsPerApp: 1,
      });
      const groupSync = registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      const oldWs = new FakeWebSocket();
      await handler.openConnection("fam", "notes", "@alice:matrix-os.com", oldWs as unknown as WebSocket);

      // Evict by opening a second connection beyond cap=1
      const newWs = new FakeWebSocket();
      await handler.openConnection("fam", "notes", "@alice:matrix-os.com", newWs as unknown as WebSocket);

      expect(oldWs.closed).toBe(true);

      const oldBinaryCount = oldWs.sentBinary().length;

      // Remote update should NOT reach the evicted socket
      const remoteDoc = new Y.Doc();
      remoteDoc.getMap("kv").set("post-evict", "val");
      groupSync.applyRemoteUpdate(Y.encodeStateAsUpdate(remoteDoc));

      await new Promise((r) => setTimeout(r, 20));
      expect(oldWs.sentBinary().length).toBe(oldBinaryCount);
    });

    it("evicted connection receives 1008 capacity close code", async () => {
      const handler = createGroupWsHandler({
        ...options,
        maxSocketsPerApp: 1,
      });
      registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      const oldWs = new FakeWebSocket();
      await handler.openConnection("fam", "notes", "@alice:matrix-os.com", oldWs as unknown as WebSocket);

      const newWs = new FakeWebSocket();
      await handler.openConnection("fam", "notes", "@alice:matrix-os.com", newWs as unknown as WebSocket);

      expect(oldWs.closedCode).toBe(1008);
      expect(oldWs.closedReason).toBe("capacity");
    });
  });

  describe("removeSubscriber cleans up empty sets", () => {
    it("deletes the key from subscriberSets when the last connection closes", async () => {
      const handler = createGroupWsHandler(options);
      const groupSync = registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      const ws = new FakeWebSocket();
      const conn = await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws as unknown as WebSocket);
      conn!.onClose();

      // After close, doc updates must not reach the closed socket (set was deleted)
      const countAfterClose = ws.sentBinary().length;
      const remoteDoc = new Y.Doc();
      remoteDoc.getMap("kv").set("late", "update");
      groupSync.applyRemoteUpdate(Y.encodeStateAsUpdate(remoteDoc));

      await new Promise((r) => setTimeout(r, 20));
      expect(ws.sentBinary().length).toBe(countAfterClose);
    });
  });

  describe("sendBinary and sendError swallow closed-socket throws", () => {
    it("does not throw when ws.send throws on a closed socket during fan-out", async () => {
      const handler = createGroupWsHandler(options);
      const groupSync = registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      const ws = new FakeWebSocket();
      // Make send throw to simulate a closed socket that didn't call onClose yet
      ws.send = () => { throw new Error("WebSocket is already in CLOSING or CLOSED state"); };

      await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws as unknown as WebSocket);

      // Remote update triggers fan-out — should not throw
      const remoteDoc = new Y.Doc();
      remoteDoc.getMap("kv").set("k", "v");
      expect(() => groupSync.applyRemoteUpdate(Y.encodeStateAsUpdate(remoteDoc))).not.toThrow();
    });

    it("does not throw when ws.send throws during error delivery", async () => {
      const handler = createGroupWsHandler(options);
      const groupSync = registry.addGroup("fam", { roomId: "!abc:matrix-os.com" });

      vi.spyOn(groupSync as unknown as FakeGroupSync, "applyLocalMutation").mockRejectedValue(
        new Error("too_large op"),
      );

      const ws = new FakeWebSocket();
      const conn = await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws as unknown as WebSocket);

      // Make send throw after connection is open
      ws.send = () => { throw new Error("already closed"); };

      const clientDoc = new Y.Doc();
      // Should not throw despite ws.send failing
      await expect(
        new Promise<void>((resolve) => {
          conn!.onMessage(buildUpdate(Y.encodeStateAsUpdate(clientDoc)));
          setTimeout(resolve, 30);
        })
      ).resolves.not.toThrow();
    });
  });

  describe("openConnection returns null when sync handle unavailable", () => {
    it("returns null and sends sync_failed when getSyncHandle returns null", async () => {
      const noSyncRegistry: GroupWsGroupRegistry = {
        get: () => ({ room_id: "!abc:matrix-os.com" }),
        getSyncHandle: () => null,
        getAcl: () => ({ read_pl: 0, write_pl: 0 }),
        getMemberPowerLevel: () => 100,
      };
      const handler = createGroupWsHandler({
        groupRegistry: noSyncRegistry,
        verifyToken: makeAuthVerifier("valid-token", "@alice:matrix-os.com"),
      });

      const ws = new FakeWebSocket();
      const conn = await handler.openConnection("fam", "notes", "@alice:matrix-os.com", ws as unknown as WebSocket);

      expect(conn).toBeNull();
      const errors = ws.parseSentErrors();
      expect(errors.some((e) => e.code === "sync_failed")).toBe(true);
    });
  });
});
