import type { Context } from "hono";
import type {
  FileDirectoryClientMessage,
} from "../ws-message-schema.js";
import type { Watcher } from "../watcher.js";
import { getOptionalRequestPrincipal, requireRequestPrincipal } from "../request-principal.js";
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

export interface FileDirectoryWsLifecycle {
  onClose(): Promise<void>;
}

export interface MainWsFileDirectoryRouter {
  handleFrame(frame: FileDirectoryClientMessage): void;
  rejectInvalidFrame(): void;
  close(): Promise<void>;
}

export type AuthenticatedFileDirectoryWsConnectionOptions = Omit<
  FileDirectoryWsConnectionOptions,
  "ownerId"
>;

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
      const cleanup = options.hub.removeConnection(
        options.ownerId,
        options.connectionId,
      );
      closePromise = Promise.all([tail, cleanup]).then(() => options.hub.removeConnection(
        options.ownerId,
        options.connectionId,
      ));
      return closePromise;
    },
  };
}

export function createAuthenticatedFileDirectoryWsConnection(
  context: Context,
  options: AuthenticatedFileDirectoryWsConnectionOptions,
): FileDirectoryWsConnection {
  return createFileDirectoryWsConnection({
    ...options,
    ownerId: requireRequestPrincipal(context).userId,
  });
}

export function createOptionalAuthenticatedFileDirectoryWsConnection(
  context: Context,
  options: AuthenticatedFileDirectoryWsConnectionOptions,
): FileDirectoryWsConnection | null {
  const principal = getOptionalRequestPrincipal(context);
  return principal ? createFileDirectoryWsConnection({ ...options, ownerId: principal.userId }) : null;
}

export function createMainWsFileDirectoryRouter(
  context: Context,
  options: AuthenticatedFileDirectoryWsConnectionOptions,
): MainWsFileDirectoryRouter {
  const connection = createOptionalAuthenticatedFileDirectoryWsConnection(context, options);
  const rejectUnavailable = () => {
    safeSend(options.send, {
      type: "kernel:error",
      message: GENERIC_FILE_SUBSCRIPTION_ERROR,
    });
  };
  return {
    handleFrame(frame) {
      if (connection) connection.enqueue(frame);
      else rejectUnavailable();
    },
    rejectInvalidFrame() {
      if (connection) connection.rejectInvalidFrame();
      else rejectUnavailable();
    },
    close() {
      return connection ? connection.close() : Promise.resolve();
    },
  };
}

export function createFileDirectoryWsLifecycle(
  connection: Pick<FileDirectoryWsConnection, "close">,
): FileDirectoryWsLifecycle {
  return {
    async onClose() {
      try {
        await connection.close();
      } catch (error: unknown) {
        console.error("[files/realtime] Connection cleanup failed", {
          errorKind: error instanceof Error ? error.name : typeof error,
        });
      }
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
