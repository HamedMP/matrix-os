import type { Kysely } from "kysely";
import type { Agent } from "undici";
import type { ClerkAuth } from "../clerk-auth.js";
import {
  getPlatformUserByClerkId,
  getUserMachine,
  listActivePlatformUsersByNormalizedHandle,
  type PlatformDB,
} from "../db.js";
import { createJourneyUserResolver } from "../journey-routes.js";
import { buildPlatformVerificationToken, timingSafeTokenEquals } from "../platform-token.js";
import type { CollaborationPlatformDatabase } from "./database.js";
import { createFailClosedPlatformCollaboration } from "./fail-closed.js";
import {
  createPlatformCollaboration,
  describePlatformCollaborationConfiguration,
  type PlatformCollaborationComposition,
} from "./wiring.js";
import { PlatformCollaborationIdentifierResolver } from "./identifier-resolver.js";

export interface BootstrapPlatformCollaborationOptions {
  env: NodeJS.ProcessEnv;
  db: PlatformDB;
  platformSecret: string;
  platformJwtSecret: string;
  clerkAuth?: ClerkAuth;
  customerVpsProxyDispatcher: Agent;
}

/**
 * Always returns a composition: the real runtime when signing/origin/runtime
 * authentication configuration is complete, otherwise the fail-closed
 * registrar that denies every collaboration route with a logged generic
 * reason. There is no release flag (S20 / T099).
 */
export async function bootstrapPlatformCollaboration(
  options: BootstrapPlatformCollaborationOptions,
): Promise<PlatformCollaborationComposition> {
  const health = describePlatformCollaborationConfiguration(options.env);
  if (!health.configured) return createFailClosedPlatformCollaboration({ reason: health.reason });
  if (!options.platformSecret) {
    return createFailClosedPlatformCollaboration({ reason: "runtime_authentication_missing" });
  }
  const config = health.config;

  const identifierResolver = new PlatformCollaborationIdentifierResolver({
    ...(options.env.CLERK_SECRET_KEY ? { clerkSecretKey: options.env.CLERK_SECRET_KEY } : {}),
    getAccountByActorId: async (actorId) => {
      const user = await getPlatformUserByClerkId(options.db, actorId);
      return user?.status === "active" ? { actorId: user.clerkId, displayName: user.displayName } : null;
    },
    listAccountsByUsername: async (username) => (await listActivePlatformUsersByNormalizedHandle(options.db, username))
      .map((user) => ({ actorId: user.clerkId, displayName: user.displayName })),
  });

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
    // No membership projection is registered until S03 lands, so every identifier resolves to
    // nothing: the organization is the only audience and there is no person-to-person path.
    resolveInvitationIdentifier: (identifier, organizationId) => identifierResolver.resolve(identifier, organizationId),
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
