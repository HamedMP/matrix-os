import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { GroupSyncOnChange } from "./group-sync.js";

// ---------------------------------------------------------------------------
// Coarse error codes — closed set per spec §J.
// ---------------------------------------------------------------------------

type WsErrorCode = "sync_failed" | "acl_denied" | "offline" | "op_too_large" | "state_overflow";

// ---------------------------------------------------------------------------
// Public interface types for constructor injection (testable without real deps)
// ---------------------------------------------------------------------------

export interface GroupWsMemberEntry {
  handle: string;
  role: "owner" | "editor" | "viewer";
  membership: "join" | "invite" | "leave" | "ban" | "knock";
  display_name?: string;
}

export interface GroupWsPresenceEntry {
  handle: string;
  status: "online" | "unavailable" | "offline";
  last_active_ago?: number;
  currently_active?: boolean;
}

export interface GroupWsGroupSync {
  getDoc(appSlug: string): Y.Doc;
  onChange(appSlug: string, listener: GroupSyncOnChange): { dispose(): void };
  applyLocalMutation(appSlug: string, mutator: (doc: Y.Doc) => void): Promise<void>;
  getMembers(): GroupWsMemberEntry[];
  getPresence(): Record<string, GroupWsPresenceEntry>;
  onMembersChanged(cb: (members: GroupWsMemberEntry[]) => void): { dispose(): void };
  onPresenceChanged(cb: (handle: string, entry: GroupWsPresenceEntry) => void): { dispose(): void };
}

export interface GroupWsGroupRegistry {
  get(slug: string): { room_id: string } | null;
  getSyncHandle(slug: string): GroupWsGroupSync | null;
  getAcl(slug: string, appSlug: string): { read_pl: number; write_pl: number } | null;
  getMemberPowerLevel(slug: string, userHandle: string): number;
}

export interface GroupWsHandlerOptions {
  groupRegistry: GroupWsGroupRegistry;
  verifyToken: (token: string) => Promise<string | null>;
  /** Maximum WS connections per (group, app) pair. Defaults to 1000. Drop-oldest on overflow. */
  maxSocketsPerApp?: number;
}

export interface UpgradeResult {
  status: number;
  error?: string;
}

export interface WsConnection {
  onMessage(data: Uint8Array | ArrayBuffer): void;
  onClose(): void;
}

export interface GroupWsHandler {
  handleUpgrade(groupSlug: string, appSlug: string, token: string | null): Promise<UpgradeResult>;
  openConnection(
    groupSlug: string,
    appSlug: string,
    userHandle: string,
    ws: WebSocket,
  ): Promise<WsConnection | null>;
}

// ---------------------------------------------------------------------------
// Per-connection state — no shared mutable buffers across sockets
// ---------------------------------------------------------------------------

interface ConnState {
  ws: WebSocket;
  groupSlug: string;
  appSlug: string;
  userHandle: string;
  stateVector: Uint8Array;
  changeSub: { dispose(): void } | null;
  membersSub: { dispose(): void } | null;
  presenceSub: { dispose(): void } | null;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function appKey(groupSlug: string, appSlug: string): string {
  return `${groupSlug}:${appSlug}`;
}

function sendBinary(ws: WebSocket, data: Uint8Array): void {
  try {
    ws.send(data);
  } catch {
    // socket closed
  }
}

function sendError(ws: WebSocket, code: WsErrorCode): void {
  try {
    ws.send(JSON.stringify({ type: "error", code }));
  } catch {
    // socket closed
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createGroupWsHandler(opts: GroupWsHandlerOptions): GroupWsHandler {
  const { groupRegistry } = opts;
  const maxSockets = opts.maxSocketsPerApp ?? 1000;

  // Per-(group:app) subscriber sets. Bounded to `maxSockets`.
  const subscriberSets = new Map<string, Set<ConnState>>();

  function getSubscribers(key: string): Set<ConnState> {
    let set = subscriberSets.get(key);
    if (!set) {
      set = new Set();
      subscriberSets.set(key, set);
    }
    return set;
  }

  function addSubscriber(key: string, conn: ConnState): void {
    const set = getSubscribers(key);
    if (set.size >= maxSockets) {
      // Drop oldest — first item in the set insertion order
      const oldest = set.values().next().value;
      if (oldest) {
        set.delete(oldest);
        oldest.changeSub?.dispose();
        try { oldest.ws.close(1008, "capacity"); } catch { /* already closed */ }
        console.warn(JSON.stringify({ level: "warn", event: "group_ws_capacity_drop", key }));
      }
    }
    set.add(conn);
  }

  function removeSubscriber(key: string, conn: ConnState): void {
    const set = subscriberSets.get(key);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) subscriberSets.delete(key);
  }

  async function handleUpgrade(
    groupSlug: string,
    appSlug: string,
    token: string | null,
  ): Promise<UpgradeResult> {
    // 1. Bearer auth
    if (!token) {
      return { status: 401, error: "Unauthorized" };
    }
    const userHandle = await opts.verifyToken(token);
    if (!userHandle) {
      return { status: 401, error: "Unauthorized" };
    }

    // 2. Group membership
    const manifest = groupRegistry.get(groupSlug);
    if (!manifest) {
      return { status: 403, error: "Forbidden" };
    }

    // 3. ACL read_pl check
    const acl = groupRegistry.getAcl(groupSlug, appSlug);
    const userPl = groupRegistry.getMemberPowerLevel(groupSlug, userHandle);
    const readPl = acl?.read_pl ?? 0;
    if (userPl < readPl) {
      return { status: 4403, error: "acl_denied" };
    }

    return { status: 200 };
  }

  async function openConnection(
    groupSlug: string,
    appSlug: string,
    userHandle: string,
    ws: WebSocket,
  ): Promise<WsConnection | null> {
    const key = appKey(groupSlug, appSlug);
    const groupSync = groupRegistry.getSyncHandle(groupSlug);
    if (!groupSync) {
      sendError(ws, "sync_failed");
      return null;
    }

    // groupSync is non-null here — we returned null above if it was null
    const sync: GroupWsGroupSync = groupSync;

    let doc: Y.Doc;
    try {
      doc = sync.getDoc(appSlug);
    } catch {
      sendError(ws, "sync_failed");
      return null;
    }

    // Per-connection state vector — independent of other sockets
    const stateVector = Y.encodeStateVector(doc);

    // Send syncStep1 to client so it can send back what it has that we don't
    const step1Encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(step1Encoder, doc);
    sendBinary(ws, encoding.toUint8Array(step1Encoder));

    const conn: ConnState = {
      ws,
      groupSlug,
      appSlug,
      userHandle,
      stateVector,
      changeSub: null,
      membersSub: null,
      presenceSub: null,
    };

    // Send initial members + presence snapshots as greeting JSON frames
    try {
      ws.send(JSON.stringify({ type: "members_changed", members: sync.getMembers() }));
      ws.send(JSON.stringify({ type: "presence_snapshot", presence: sync.getPresence() }));
    } catch {
      // socket may have closed before greeting — non-fatal
    }

    // Subscribe to live member list changes and fan out
    conn.membersSub = sync.onMembersChanged((members) => {
      try {
        ws.send(JSON.stringify({ type: "members_changed", members }));
      } catch {
        // socket closed
      }
    });

    // Subscribe to per-handle presence changes and fan out
    conn.presenceSub = sync.onPresenceChanged((handle, entry) => {
      try {
        ws.send(JSON.stringify({ type: "presence_changed", ...entry }));
      } catch {
        // socket closed
      }
    });

    // Subscribe to doc changes and fan out to this socket
    conn.changeSub = sync.onChange(appSlug, (_info) => {
      // On any change, send the delta since last known state vector
      try {
        const update = Y.encodeStateAsUpdate(doc, conn.stateVector);
        conn.stateVector = Y.encodeStateVector(doc);
        if (update.length > 0) {
          const upEncoder = encoding.createEncoder();
          syncProtocol.writeUpdate(upEncoder, update);
          sendBinary(ws, encoding.toUint8Array(upEncoder));
        }
      } catch {
        // ignore — ws may have closed
      }
    });

    addSubscriber(key, conn);

    function onMessage(data: Uint8Array | ArrayBuffer): void {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

      // Re-check ACL on every inbound message (spec §H defense in depth)
      const acl = groupRegistry.getAcl(groupSlug, appSlug);
      const userPl = groupRegistry.getMemberPowerLevel(groupSlug, userHandle);
      const readPl = acl?.read_pl ?? 0;
      if (userPl < readPl) {
        sendError(ws, "acl_denied");
        conn.changeSub?.dispose();
        conn.membersSub?.dispose();
        conn.presenceSub?.dispose();
        removeSubscriber(key, conn);
        try { ws.close(4403, "acl_denied"); } catch { /* already closed */ }
        return;
      }

      const decoder = decoding.createDecoder(bytes);
      const encoder = encoding.createEncoder();

      try {
        const messageType = decoding.readVarUint(decoder);

        if (messageType === syncProtocol.messageYjsSyncStep1) {
          // Client is sending its state vector — reply with what it's missing
          syncProtocol.readSyncStep1(decoder, encoder, doc);
          const reply = encoding.toUint8Array(encoder);
          if (reply.length > 0) {
            sendBinary(ws, reply);
          }
          conn.stateVector = Y.encodeStateVector(doc);
        } else if (messageType === syncProtocol.messageYjsSyncStep2) {
          // Client syncs its state to us — apply via applyLocalMutation
          const update = decoding.readVarUint8Array(decoder);
          sync
            .applyLocalMutation(appSlug, (d) => {
              Y.applyUpdate(d, update, "remote");
            })
            .catch((err) => {
              sendError(ws, mapError(err));
            });
          conn.stateVector = Y.encodeStateVector(doc);
        } else if (messageType === syncProtocol.messageYjsUpdate) {
          // Regular update from client
          const update = decoding.readVarUint8Array(decoder);
          const writePl = acl?.write_pl ?? 0;
          if (userPl < writePl) {
            sendError(ws, "acl_denied");
            return;
          }
          sync
            .applyLocalMutation(appSlug, (d) => {
              Y.applyUpdate(d, update, "remote");
            })
            .catch((err) => {
              sendError(ws, mapError(err));
            });
        }
        // awareness messages: placeholder rejection in v1
      } catch (err) {
        sendError(ws, mapError(err));
      }
    }

    function onClose(): void {
      conn.changeSub?.dispose();
      conn.membersSub?.dispose();
      conn.presenceSub?.dispose();
      removeSubscriber(key, conn);
    }

    return { onMessage, onClose };
  }

  return { handleUpgrade, openConnection };
}

// ---------------------------------------------------------------------------
// Map internal errors to the five coarse codes (spec §J — closed set)
// ---------------------------------------------------------------------------

function mapError(err: unknown): WsErrorCode {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("acl") || msg.includes("forbidden") || msg.includes("power")) return "acl_denied";
    if (msg.includes("too_large") || msg.includes("op_too_large")) return "op_too_large";
    if (msg.includes("overflow") || msg.includes("state_overflow")) return "state_overflow";
    if (msg.includes("offline") || msg.includes("disconnect")) return "offline";
  }
  return "sync_failed";
}
