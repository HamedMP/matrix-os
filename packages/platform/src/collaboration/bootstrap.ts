import type { Kysely } from "kysely";
import type { Agent } from "undici";
import type { ClerkAuth } from "../clerk-auth.js";
import {
  getPlatformUserByClerkId,
  getUserMachine,
  type PlatformDB,
} from "../db.js";
import { createJourneyUserResolver } from "../journey-routes.js";
import { buildPlatformVerificationToken, timingSafeTokenEquals } from "../platform-token.js";
import type { CollaborationPlatformDatabase } from "./database.js";
import {
  createPlatformCollaboration,
  loadPlatformCollaborationConfig,
  type PlatformCollaborationRuntime,
} from "./wiring.js";

export interface BootstrapPlatformCollaborationOptions {
  env: NodeJS.ProcessEnv;
  db: PlatformDB;
  platformSecret: string;
  platformJwtSecret: string;
  clerkAuth?: ClerkAuth;
  customerVpsProxyDispatcher: Agent;
}

export async function bootstrapPlatformCollaboration(
  options: BootstrapPlatformCollaborationOptions,
): Promise<PlatformCollaborationRuntime | undefined> {
  const config = loadPlatformCollaborationConfig(options.env);
  if (options.env.MATRIX_COLLABORATION_ENABLED === "true" && !config) {
    throw new Error("Platform collaboration configuration is incomplete");
  }
  if (!config) return undefined;
  if (!options.platformSecret) {
    throw new Error("Platform collaboration runtime authentication is unavailable");
  }

  return createPlatformCollaboration({
    db: options.db.kysely as unknown as Kysely<CollaborationPlatformDatabase>,
    config,
    resolveActor: createJourneyUserResolver({
      clerkAuth: options.clerkAuth,
      syncJwtSecret: options.platformJwtSecret,
    }),
    authenticateRuntime: async ({ runtimeId, bearerToken }) => {
      const machineId = parseVpsRuntimeId(runtimeId);
      if (!machineId) return null;
      const machine = await getUserMachine(options.db, machineId);
      if (!machine || machine.status !== "running"
        || !timingSafeTokenEquals(
          bearerToken,
          buildPlatformVerificationToken(machine.handle, options.platformSecret),
        )) {
        return null;
      }
      return { runtimeId, ownerId: machine.clerkUserId };
    },
    resolveParticipant: async (actorId) => {
      const user = await getPlatformUserByClerkId(options.db, actorId);
      return user ? { actorId, displayName: user.displayName } : null;
    },
    resolveRuntime: async (runtimeId) => {
      const machineId = parseVpsRuntimeId(runtimeId);
      if (!machineId) return null;
      const machine = await getUserMachine(options.db, machineId);
      if (!machine || machine.status !== "running" || !machine.publicIPv4) return null;
      return {
        runtimeId,
        ownerId: machine.clerkUserId,
        baseUrl: `https://${machine.publicIPv4}:443`,
      };
    },
    fetchImpl: (input, init) => fetch(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(10_000),
      dispatcher: options.customerVpsProxyDispatcher,
    } as RequestInit & { dispatcher: import("undici").Dispatcher }),
  });
}

function parseVpsRuntimeId(runtimeId: string): string | null {
  const match = /^vps:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(runtimeId);
  return match?.[1] ?? null;
}
