import type {
  FileDirectoryClientMessage,
} from "../ws-message-schema.js";
import type { Watcher } from "../watcher.js";
import type {
  FileDirectorySubscriptionHub,
} from "../file-management/directory-subscriptions.js";

const DEFAULT_MAX_PENDING_FILE_FRAMES = 16;
const GENERIC_FILE_SUBSCRIPTION_ERROR = "File directory subscription failed";

export interface FileDirectoryWsConnectionOptions {
  ownerId: string;
  connectionId: string;
  hub: FileDirectorySubscriptionHub;
  send: (message: string) => void | boolean;
  closeSocket: () => void;
  maxPendingFrames?: number;
}

export interface FileDirectoryWsConnection {
  enqueue(frame: FileDirectoryClientMessage): boolean;
  rejectInvalidFrame(): void;
  idle(): Promise<void>;
  close(): Promise<void>;
}

function safeSend(
  send: FileDirectoryWsConnectionOptions["send"],
  message: unknown,
): boolean {
  try {
    return send(JSON.stringify(message)) !== false;
  } catch (error: unknown) {
    console.error("[files/realtime] Error response send failed", {
      errorKind: error instanceof Error ? error.name : typeof error,
    });
    return false;
  }
}

export function createFileDirectoryWsConnection(
  options: FileDirectoryWsConnectionOptions,
): FileDirectoryWsConnection {
  const maxPendingFrames = options.maxPendingFrames ?? DEFAULT_MAX_PENDING_FILE_FRAMES;
  let tail = Promise.resolve();
  let pendingFrames = 0;
  let failed = false;
  let closing = false;
  let closePromise: Promise<void> | null = null;

  const failConnection = (error: unknown) => {
    if (failed || closing) return;
    failed = true;
    console.error("[files/realtime] File frame failed", {
      ownerId: options.ownerId,
      connectionId: options.connectionId,
      error: error instanceof Error ? error.message : String(error),
    });
    safeSend(options.send, {
      type: "kernel:error",
      message: GENERIC_FILE_SUBSCRIPTION_ERROR,
    });
    try {
      options.closeSocket();
    } catch (closeError: unknown) {
      console.error("[files/realtime] WebSocket close failed", {
        errorKind: closeError instanceof Error ? closeError.name : typeof closeError,
      });
    }
  };

  const processFrame = async (frame: FileDirectoryClientMessage) => {
    if (closing || failed) return;
    if (frame.type === "files:subscribe") {
      const revision = await options.hub.subscribe({
        ownerId: options.ownerId,
        connectionId: options.connectionId,
        directory: frame.directory,
        send: options.send,
      });
      if (closing || failed) return;
      if (!safeSend(options.send, {
        type: "files:subscribed",
        directory: frame.directory,
        revision,
      })) {
        throw new Error("Subscription acknowledgement send failed");
      }
      return;
    }
    if (frame.type === "files:touch") {
      if (!options.hub.touch(options.ownerId, options.connectionId, frame.directory)) {
        throw new Error("Directory subscription not found");
      }
      return;
    }
    await options.hub.unsubscribe(options.ownerId, options.connectionId, frame.directory);
  };

  return {
    enqueue(frame) {
      if (closing || failed) return false;
      if (pendingFrames >= maxPendingFrames) {
        failConnection(new Error("Pending file frame limit reached"));
        return false;
      }
      pendingFrames += 1;
      tail = tail
        .then(() => processFrame(frame))
        .catch((error: unknown) => {
          failConnection(error);
        })
        .finally(() => {
          pendingFrames -= 1;
        });
      return true;
    },

    rejectInvalidFrame() {
      failConnection(new Error("Invalid file directory frame"));
    },

    idle() {
      return tail;
    },

    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = tail.then(() => options.hub.removeConnection(
        options.ownerId,
        options.connectionId,
      ));
      return closePromise;
    },
  };
}

export function isFileDirectoryFrameCandidate(frame: unknown): boolean {
  if (!frame || typeof frame !== "object") return false;
  const type = Reflect.get(frame, "type");
  return typeof type === "string" && type.startsWith("files:");
}

export function bindFileDirectoryWatcher(
  hub: FileDirectorySubscriptionHub,
  watcher: Pick<Watcher, "on">,
): void {
  watcher.on((event) => {
    void hub.broadcast(event).catch((error: unknown) => {
      console.error("[files/realtime] Watcher event delivery failed", {
        errorKind: error instanceof Error ? error.name : typeof error,
      });
    });
  });
}

export async function closeFileDirectoryResources(
  hub: Pick<FileDirectorySubscriptionHub, "close">,
  watcher: Pick<Watcher, "close">,
): Promise<void> {
  await hub.close();
  await watcher.close();
}
