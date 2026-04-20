import type { PeerInfo } from "./types.js";

const MAX_PEERS_PER_USER = 100;
const MAX_USERS = 10_000;

export interface SyncPeerConnection {
  send(data: string): void;
  readyState: number;
  close?: (code?: number, reason?: string) => void;
}

interface PeerEntry {
  info: PeerInfo;
  ws: SyncPeerConnection;
}

export interface PeerRegistry {
  registerPeer(
    userId: string,
    params: {
      peerId: string;
      hostname: string;
      platform: "darwin" | "linux" | "win32";
      clientVersion: string;
    },
    ws: SyncPeerConnection,
  ): PeerInfo;
  removePeer(userId: string, peerId: string): void;
  broadcastChange(userId: string, senderPeerId: string, message: Record<string, unknown>): void;
  sendToUser(userId: string, message: Record<string, unknown>): void;
  getPeers(userId: string): PeerInfo[];
  getTotalPeerCount(): number;
}

export function createPeerRegistry(): PeerRegistry {
  // userId -> peerId -> PeerEntry
  const userPeers = new Map<string, Map<string, PeerEntry>>();

  function sendSafe(ws: SyncPeerConnection, data: string): void {
    if (ws.readyState === 1) {
      ws.send(data);
    }
  }

  function evictPeer(
    peers: Map<string, PeerEntry>,
    peerId: string,
    reason: string,
  ): void {
    const entry = peers.get(peerId);
    if (!entry) return;
    sendSafe(entry.ws, JSON.stringify({ type: "sync:evicted", reason }));
    entry.ws.close?.(4000, "sync peer evicted");
    peers.delete(peerId);
  }

  function evictUserBucket(userId: string, reason: string): void {
    const peers = userPeers.get(userId);
    if (!peers) return;
    for (const peerId of Array.from(peers.keys())) {
      evictPeer(peers, peerId, reason);
    }
    userPeers.delete(userId);
  }

  function getUserMap(userId: string): Map<string, PeerEntry> {
    let map = userPeers.get(userId);
    if (map) {
      userPeers.delete(userId);
      userPeers.set(userId, map);
      return map;
    }

    if (userPeers.size >= MAX_USERS) {
      const oldestUserId = userPeers.keys().next().value;
      if (oldestUserId !== undefined) {
        evictUserBucket(oldestUserId, "user_registry_cap");
      }
    }

    map = new Map();
    userPeers.set(userId, map);
    return map;
  }

  return {
    registerPeer(userId, params, ws) {
      const peers = getUserMap(userId);

      // LRU eviction: if at cap, remove the oldest (first entry in Map iteration order)
      if (peers.size >= MAX_PEERS_PER_USER && !peers.has(params.peerId)) {
        const oldestKey = peers.keys().next().value;
        if (oldestKey !== undefined) {
          evictPeer(peers, oldestKey, "peer_limit");
          // Broadcast peer-leave for the evicted peer
          const leaveMsg = JSON.stringify({ type: "sync:peer-leave", peerId: oldestKey });
          for (const entry of peers.values()) {
            sendSafe(entry.ws, leaveMsg);
          }
        }
      }

      const info: PeerInfo = {
        peerId: params.peerId,
        userId,
        hostname: params.hostname,
        platform: params.platform,
        clientVersion: params.clientVersion,
        connectedAt: Date.now(),
      };

      // Broadcast peer-join to existing peers BEFORE adding the new peer
      const joinMsg = JSON.stringify({
        type: "sync:peer-join",
        peerId: params.peerId,
        hostname: params.hostname,
        platform: params.platform,
      });
      for (const entry of peers.values()) {
        if (entry.info.peerId !== params.peerId) {
          sendSafe(entry.ws, joinMsg);
        }
      }

      peers.set(params.peerId, { info, ws });

      return info;
    },

    removePeer(userId, peerId) {
      const peers = userPeers.get(userId);
      if (!peers) return;

      peers.delete(peerId);

      // Broadcast peer-leave to remaining peers
      const leaveMsg = JSON.stringify({ type: "sync:peer-leave", peerId });
      for (const entry of peers.values()) {
        sendSafe(entry.ws, leaveMsg);
      }

      if (peers.size === 0) {
        userPeers.delete(userId);
      }
    },

    broadcastChange(userId, senderPeerId, message) {
      const peers = userPeers.get(userId);
      if (!peers) return;

      const data = JSON.stringify(message);
      for (const entry of peers.values()) {
        if (entry.info.peerId !== senderPeerId) {
          sendSafe(entry.ws, data);
        }
      }
    },

    sendToUser(userId, message) {
      const peers = userPeers.get(userId);
      if (!peers) return;

      const data = JSON.stringify(message);
      for (const entry of peers.values()) {
        sendSafe(entry.ws, data);
      }
    },

    getPeers(userId) {
      const peers = userPeers.get(userId);
      if (!peers) return [];
      return Array.from(peers.values()).map((e) => e.info);
    },

    getTotalPeerCount() {
      let total = 0;
      for (const peers of userPeers.values()) {
        total += peers.size;
      }
      return total;
    },
  };
}
