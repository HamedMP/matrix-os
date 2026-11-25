import type { MessagingBridgeChangedEvent } from "@matrix-os/contracts/messaging-bridge";
import { errorName } from "./bridge-http.js";
import { createBridgeMatrixClient } from "./bridge-matrix-client.js";
import { createMessagingBridgePlatformClient } from "./bridge-platform-client.js";
import { createMessagingBridgeService, type MessagingBridgeService } from "./bridge-service.js";
import { createBridgeSessionProvider, createFileBridgeSessionStore } from "./bridge-session.js";
import type { MessagingBridgeStore } from "./bridge-store.js";
import { createBridgeSyncService, createPostgresAdvisoryLock } from "./bridge-sync.js";

/** Composition root for the bridge data plane; every dependency is resolved here, once, at startup. */

export const LINK_SWEEP_INTERVAL_MS = 60_000;

export interface MessagingBridgeRuntime {
  service: MessagingBridgeService;
  close(): Promise<void>;
}

export interface MessagingBridgeRuntimeOptions {
  platformUrl: string | undefined;
  machineToken: string | undefined;
  handle: string | undefined;
  runtimeOwnerId: string | undefined;
  homePath: string;
  store: MessagingBridgeStore | null;
  broadcast(ownerId: string, event: MessagingBridgeChangedEvent): void;
  fetchImpl?: typeof fetch;
}

/** Null when any dependency is missing; the routes then answer `unavailable` / `503 misconfigured`. */
export function createMessagingBridgeRuntime(options: MessagingBridgeRuntimeOptions): MessagingBridgeRuntime | null {
  const { platformUrl, machineToken, handle, runtimeOwnerId, store } = options;
  if (!platformUrl || !machineToken || !handle || !runtimeOwnerId || !store) return null;
  let platform;
  try {
    platform = createMessagingBridgePlatformClient({ platformUrl, machineToken, handle, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  } catch (err: unknown) {
    console.warn("[messages/bridge-runtime] platform client unavailable", errorName(err));
    return null;
  }
  const matrix = createBridgeMatrixClient(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {});
  const sessions = createBridgeSessionProvider({
    ownerId: runtimeOwnerId,
    store: createFileBridgeSessionStore({ homePath: options.homePath }),
    platform,
  });
  const sync = createBridgeSyncService({
    ownerId: runtimeOwnerId,
    store,
    sessions,
    matrix,
    lock: createPostgresAdvisoryLock(store.database),
    onChanged: (event) => options.broadcast(runtimeOwnerId, event),
  });
  const service = createMessagingBridgeService({
    ownerId: runtimeOwnerId,
    platform,
    store,
    sessions,
    matrix,
    sync,
    broadcast: options.broadcast,
  });
  const sweepTimer = setInterval(() => service.sweep(), LINK_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
  void service.resume();
  return {
    service,
    async close() {
      clearInterval(sweepTimer);
      await service.close();
    },
  };
}
