import type { Kysely } from "kysely";
import { createManifestDb } from "./db-impl.js";
import {
  createHomeMirror,
  type HomeMirror,
  type HomeMirrorConfig,
} from "./home-mirror.js";
import {
  createHomeMirrorReadiness,
  type HomeMirrorReadiness,
} from "./home-mirror-readiness.js";
import type { R2Client } from "./r2-client.js";
import {
  deriveHomeMirrorSyncIdentity,
  resolveSyncScope,
} from "./runtime-scope.js";
import type { SyncDatabase } from "./sharing-db.js";
import type { PeerRegistry } from "./ws-events.js";

interface HomeMirrorLifecycleLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

interface GatewayHomeMirrorLifecycleOptions {
  enabled: boolean;
  homeRoot: string;
  syncR2: R2Client | null;
  kyselyInstance: Kysely<SyncDatabase> | null;
  peerRegistry: PeerRegistry | null;
  env?: NodeJS.ProcessEnv;
  logger?: HomeMirrorLifecycleLogger;
  createMirror?: (config: HomeMirrorConfig) => HomeMirror;
}

export interface GatewayHomeMirrorLifecycle {
  mirror: HomeMirror | null;
  startup: Promise<void> | null;
  readiness: HomeMirrorReadiness;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createGatewayHomeMirrorLifecycle(
  options: GatewayHomeMirrorLifecycleOptions,
): GatewayHomeMirrorLifecycle {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const readiness = createHomeMirrorReadiness(options.enabled);
  const emptyLifecycle = (): GatewayHomeMirrorLifecycle => ({
    mirror: null,
    startup: null,
    readiness,
  });

  if (!options.enabled) {
    return emptyLifecycle();
  }
  if (!options.syncR2 || !options.kyselyInstance) {
    readiness.markFailed();
    logger.error("[home-mirror] sync infrastructure is unavailable");
    return emptyLifecycle();
  }
  if (env.NODE_ENV === "production" && !env.MATRIX_USER_ID) {
    throw new Error(
      "[home-mirror] MATRIX_USER_ID is required in production when MATRIX_HOME_MIRROR=true. Check that the platform orchestrator injected it.",
    );
  }

  try {
    const baseUserId = env.MATRIX_USER_ID ?? env.MATRIX_HANDLE ?? "default";
    if (!env.MATRIX_USER_ID) {
      logger.warn(
        "[home-mirror] MATRIX_USER_ID not set; using MATRIX_HANDLE fallback. This is dev-only behaviour.",
      );
    }
    const scope = resolveSyncScope({
      ownerId: baseUserId,
      runtimeSlot: env.MATRIX_RUNTIME_SLOT,
    });
    const { peerId } = deriveHomeMirrorSyncIdentity({
      baseUserId,
      runtimeSlot: env.MATRIX_RUNTIME_SLOT,
    });
    const mirrorFactory = options.createMirror ?? createHomeMirror;
    const mirror = mirrorFactory({
      r2: options.syncR2,
      manifestDb: createManifestDb(options.kyselyInstance),
      homeRoot: options.homeRoot,
      userId: scope.ownerId,
      scope,
      peerId,
      peerRegistry: options.peerRegistry ?? undefined,
      logger: {
        info: (message, ...args) => logger.info(`[home-mirror] ${message}`, ...args),
        error: (message, ...args) => logger.error(`[home-mirror] ${message}`, ...args),
      },
    });
    const startup = mirror.start().then(() => {
      readiness.markReady();
    }).catch(async (err: unknown) => {
      readiness.markFailed();
      logger.error("[home-mirror] start failed:", errorMessage(err));
      try {
        await mirror.stop();
      } catch (stopErr: unknown) {
        logger.error("[home-mirror] startup cleanup failed:", errorMessage(stopErr));
      }
    });

    return { mirror, startup, readiness };
  } catch (err: unknown) {
    readiness.markFailed();
    logger.error("[home-mirror] init failed:", errorMessage(err));
    return emptyLifecycle();
  }
}
