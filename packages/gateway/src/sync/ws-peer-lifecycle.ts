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
      if (activePeerId && activePeerId !== params.peerId) {
        registry.removePeer(userId, activePeerId);
      }
      const info = registry.registerPeer(userId, params, connection);
      activePeerId = params.peerId;
      return info;
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
