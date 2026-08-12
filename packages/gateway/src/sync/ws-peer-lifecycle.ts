import type { PeerInfo } from "./types.js";
import type { PeerRegistry, SyncPeerConnection } from "./ws-events.js";

type PeerParams = Pick<PeerInfo, "peerId" | "hostname" | "platform" | "clientVersion">;
type WsLike = Pick<SyncPeerConnection, "send" | "readyState">;

export interface SyncPeerLifecycle {
  subscribe(params: PeerParams): PeerInfo;
  close(): void;
}

export function subscribeSyncPeerOrReject(
  lifecycle: SyncPeerLifecycle | null,
  params: PeerParams,
  reject: () => void,
): boolean {
  const rejectSubscription = () => {
    try {
      reject();
    } catch (error: unknown) {
      console.error("[sync/realtime] Subscription error response failed", {
        errorKind: error instanceof Error ? error.name : typeof error,
      });
    }
  };
  if (!lifecycle) {
    rejectSubscription();
    return false;
  }
  try {
    lifecycle.subscribe(params);
    return true;
  } catch (error: unknown) {
    console.error("[sync/realtime] Peer subscription failed", {
      errorKind: error instanceof Error ? error.name : typeof error,
    });
    rejectSubscription();
    return false;
  }
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
