// Yjs version MUST match packages/gateway/package.json. Mismatch corrupts binary updates.

import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

// ---------------------------------------------------------------------------
// Closed set of error codes (spec §J). Extending the set is a spec change.
// ---------------------------------------------------------------------------

export type SharedErrorCode =
  | "sync_failed"
  | "acl_denied"
  | "offline"
  | "op_too_large"
  | "state_overflow";

export const SHARED_ERROR_CODES: Set<string> = new Set<SharedErrorCode>([
  "sync_failed",
  "acl_denied",
  "offline",
  "op_too_large",
  "state_overflow",
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GroupMember {
  handle: string;
  role: string;
  online?: boolean;
}

export interface GroupContext {
  id: string;
  slug: string;
  name: string;
  me: { handle: string; role: string };
}

export interface GroupContextLive extends GroupContext {
  members: GroupMember[];
}

export interface SharedInterface {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  list(): string[];
  doc(): Y.Doc;
  onChange(cb: () => void): () => void;
  onError(cb: (code: SharedErrorCode) => void): () => void;
}

export interface GroupBridgeInterface {
  shared: SharedInterface;
  group: GroupContextLive | null;
}

export interface GroupBridgeOptions {
  groupContext: GroupContext | null;
  gatewayWsUrl: string;
  appSlug: string;
  wsFactory: (url: string) => WebSocket;
}

// ---------------------------------------------------------------------------
// 1 MB raw update ceiling per spec §I — outbound ops above this → op_too_large
// ---------------------------------------------------------------------------

const OP_TOO_LARGE_BYTES = 1 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createGroupBridge(opts: GroupBridgeOptions): GroupBridgeInterface {
  const { groupContext, gatewayWsUrl, appSlug, wsFactory } = opts;

  // Mirror Y.Doc — never the authoritative one (that lives in gateway GroupSync)
  const mirrorDoc = new Y.Doc();
  const kvMap = mirrorDoc.getMap<unknown>("kv");

  const onChangeListeners = new Set<() => void>();
  const onErrorListeners = new Set<(code: SharedErrorCode) => void>();

  let ws: WebSocket | null = null;
  let connected = false;

  function emitError(code: SharedErrorCode): void {
    for (const cb of onErrorListeners) {
      try { cb(code); } catch { /* listener failure must not break dispatch */ }
    }
  }

  function emitChange(): void {
    for (const cb of onChangeListeners) {
      try { cb(); } catch { /* listener failure must not break dispatch */ }
    }
  }

  function ensureConnected(): void {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return; // CONNECTING or OPEN
    if (!groupContext) return;

    ws = wsFactory(gatewayWsUrl);

    ws.addEventListener("open", () => {
      connected = true;
      // Initiate sync: send syncStep1 from current mirror state
      const encoder = encoding.createEncoder();
      syncProtocol.writeSyncStep1(encoder, mirrorDoc);
      ws!.send(encoding.toUint8Array(encoder));
    });

    ws.addEventListener("message", (evt: MessageEvent) => {
      const raw = evt.data;
      let bytes: Uint8Array;

      if (raw instanceof ArrayBuffer) {
        bytes = new Uint8Array(raw);
      } else if (raw instanceof Uint8Array) {
        bytes = raw;
      } else if (typeof raw === "string") {
        // JSON error message from gateway
        try {
          const msg = JSON.parse(raw) as { type?: string; code?: string };
          if (msg.type === "error" && msg.code && SHARED_ERROR_CODES.has(msg.code)) {
            emitError(msg.code as SharedErrorCode);
          } else if (msg.type === "error") {
            emitError("sync_failed");
          }
        } catch {
          emitError("sync_failed");
        }
        return;
      } else {
        return;
      }

      // Try decoding as JSON error first (text frames sent as binary by some WS impls)
      // Yjs sync messages start with a varuint (0, 1, or 2) — valid JSON starts with '{' (0x7b, 123)
      // which is also a valid varuint. Check if it parses as JSON first.
      const firstByte = bytes[0];
      if (firstByte === 0x7b) {
        // Could be JSON — try parsing
        try {
          const text = new TextDecoder().decode(bytes);
          const msg = JSON.parse(text) as { type?: string; code?: string };
          if (msg.type === "error" && msg.code && SHARED_ERROR_CODES.has(msg.code)) {
            emitError(msg.code as SharedErrorCode);
          } else if (msg.type === "error") {
            emitError("sync_failed");
          }
          return;
        } catch {
          // Not JSON — fall through to Yjs decode
        }
      }

      // Try decoding as binary sync message
      try {
        const decoder = decoding.createDecoder(bytes);
        const encoder = encoding.createEncoder();
        const msgType = decoding.readVarUint(decoder);

        if (msgType === syncProtocol.messageYjsSyncStep1) {
          // Server sent its state vector — send back what it's missing
          decoding.createDecoder(bytes); // rewind by re-creating
          const reDecoder = decoding.createDecoder(bytes);
          const reEncoder = encoding.createEncoder();
          syncProtocol.readSyncMessage(reDecoder, reEncoder, mirrorDoc, "server", () => undefined);
          const reply = encoding.toUint8Array(reEncoder);
          if (reply.length > 0) {
            ws!.send(reply);
          }
        } else if (msgType === syncProtocol.messageYjsSyncStep2) {
          const update = decoding.readVarUint8Array(decoder);
          Y.applyUpdate(mirrorDoc, update, "server");
          emitChange();
        } else if (msgType === syncProtocol.messageYjsUpdate) {
          const update = decoding.readVarUint8Array(decoder);
          Y.applyUpdate(mirrorDoc, update, "server");
          emitChange();
        }
      } catch {
        emitError("sync_failed");
      }
    });

    ws.addEventListener("close", (evt: CloseEvent) => {
      connected = false;
      ws = null;
      if (evt.code === 4403) {
        emitError("acl_denied");
      } else {
        emitError("offline");
      }
    });

    ws.addEventListener("error", () => {
      emitError("sync_failed");
    });
  }

  // ---------------------------------------------------------------------------
  // shared interface
  // ---------------------------------------------------------------------------

  function sendLocalUpdate(update: Uint8Array): void {
    if (update.length === 0) return;

    if (update.length > OP_TOO_LARGE_BYTES) {
      emitError("op_too_large");
      return;
    }

    if (!ws || ws.readyState !== 1) return;
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    ws.send(encoding.toUint8Array(encoder));
  }

  const shared: SharedInterface = {
    get(key: string): unknown {
      ensureConnected();
      return kvMap.get(key);
    },

    set(key: string, value: unknown): void {
      ensureConnected();
      const prevVector = Y.encodeStateVector(mirrorDoc);
      kvMap.set(key, value);
      const update = Y.encodeStateAsUpdate(mirrorDoc, prevVector);
      sendLocalUpdate(update);
    },

    delete(key: string): void {
      ensureConnected();
      const prevVector = Y.encodeStateVector(mirrorDoc);
      kvMap.delete(key);
      const update = Y.encodeStateAsUpdate(mirrorDoc, prevVector);
      sendLocalUpdate(update);
    },

    list(): string[] {
      ensureConnected();
      return Array.from(kvMap.keys());
    },

    doc(): Y.Doc {
      ensureConnected();
      return mirrorDoc;
    },

    onChange(cb: () => void): () => void {
      onChangeListeners.add(cb);
      return () => onChangeListeners.delete(cb);
    },

    onError(cb: (code: SharedErrorCode) => void): () => void {
      onErrorListeners.add(cb);
      return () => onErrorListeners.delete(cb);
    },
  };

  // ---------------------------------------------------------------------------
  // group interface
  // ---------------------------------------------------------------------------

  const group: GroupContextLive | null = groupContext
    ? {
        ...groupContext,
        members: [], // US6 wires this
      }
    : null;

  return { shared, group };
}
