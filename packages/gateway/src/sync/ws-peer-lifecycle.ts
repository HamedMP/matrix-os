import type { PeerInfo } from "./types.js";
import type { PeerRegistry, SyncPeerConnection } from "./ws-events.js";

type PeerParams = Pick<PeerInfo, "peerId" | "hostname" | "platform" | "clientVersion">;
type WsLike = Pick<SyncPeerConnection, "send" | "readyState">;

export interface SyncPeerLifecycle {
  subscribe(params: PeerParams): PeerInfo;
  close(): void;
}

export function createSyncPeerLifecycle(
  registry: PeerRegistry,
  userId: string,
  ws: WsLike,
): SyncPeerLifecycle {
  let activePeerId: string | null = null;

  const connection: SyncPeerConnection = {
    send(data: string) {
      ws.send(data);
    },
    get readyState() {
      return ws.readyState;
    },
  };

  return {
    subscribe(params) {
      const previousPeerId = activePeerId;
      try {
        const info = registry.registerPeer(userId, params, connection);
        if (previousPeerId && previousPeerId !== params.peerId) {
          registry.removePeer(userId, previousPeerId);
        }
        activePeerId = params.peerId;
        return info;
      } catch (err: unknown) {
        if (previousPeerId && previousPeerId !== params.peerId) {
          activePeerId = previousPeerId;
        } else if (!previousPeerId) {
          activePeerId = null;
        }
        throw err;
      }
    },
    close() {
      if (!activePeerId) {
        return;
      }
      registry.removePeer(userId, activePeerId);
      activePeerId = null;
    },
  };
}
