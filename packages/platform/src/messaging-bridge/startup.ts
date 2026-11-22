import type { Kysely } from "kysely";
import { createCoreRepoMachineAuthenticator } from "../core-repo/startup.js";
import type { PlatformDB } from "../db.js";
import { parseMessagingBridgeConfig } from "./config.js";
import { describeForLog, type MessagingBridgeLogger } from "./errors.js";
import {
  bootstrapMessagingBridgeDatabase,
  createMessagingBridgeIdentityStore,
  type MessagingBridgeDatabase,
  type MessagingBridgeIdentityStore,
} from "./identity.js";
import { createMessagingBridgeRoutes } from "./routes.js";

const consoleLogger: MessagingBridgeLogger = {
  warn: (message, details) => console.warn(message, details ?? {}),
  error: (message, details) => console.error(message, details ?? {}),
};

/**
 * Compose the messaging-bridge routes once at platform startup. The routes are
 * always mounted; without bridge-host configuration (or if the identity table
 * cannot be bootstrapped) they answer `503 misconfigured` instead of failing
 * platform startup for a phase-0, allowlisted feature.
 */
export async function createConfiguredMessagingBridge(options: {
  env: NodeJS.ProcessEnv;
  db: PlatformDB;
  platformSecret: string;
  fetchImpl?: typeof fetch;
  log?: MessagingBridgeLogger;
  now?: () => number;
  stepWaitMs?: number;
}) {
  const log = options.log ?? consoleLogger;
  const config = parseMessagingBridgeConfig(options.env);
  let identities: MessagingBridgeIdentityStore | undefined;
  if (config.host) {
    const kysely = options.db.kysely as unknown as Kysely<MessagingBridgeDatabase>;
    try {
      await bootstrapMessagingBridgeDatabase(kysely);
      identities = createMessagingBridgeIdentityStore(kysely);
    } catch (error: unknown) {
      log.error("[messaging-bridge] identity table bootstrap failed; routes answer misconfigured", describeForLog(error));
    }
  } else if (config.allowedHandles.size > 0) {
    log.warn("[messaging-bridge] allowlist set but bridge host is not configured; routes answer misconfigured");
  }
  return createMessagingBridgeRoutes({
    config,
    // The same machine credential check the gateway's other header-addressed internal routes use.
    authenticateMachine: createCoreRepoMachineAuthenticator(options.db, options.platformSecret),
    ...(identities ? { identities } : {}),
    fetchImpl: options.fetchImpl ?? fetch,
    log,
    ...(options.now ? { now: options.now } : {}),
    ...(options.stepWaitMs !== undefined ? { stepWaitMs: options.stepWaitMs } : {}),
  });
}
