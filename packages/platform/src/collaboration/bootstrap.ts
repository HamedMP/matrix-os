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
import type { OrganizationPlatformDatabase } from "../organizations/database.js";
import { createPlatformOrganizations } from "../organizations/wiring.js";
import { createPlatformCollaborationDirect, loadCollaborationRelayOrigin } from "./direct-wiring.js";
import { PlatformCollaborationRepository } from "./repository.js";
import type { RuntimeEndpointPlatformDatabase } from "./runtime-endpoints.js";
import { loadTicketSigningKeyring } from "./ticket-issuer.js";

export interface BootstrapPlatformCollaborationOptions {
  env: NodeJS.ProcessEnv;
  db: PlatformDB;
  platformSecret: string;
  platformJwtSecret: string;
  clerkAuth?: ClerkAuth;
  customerVpsProxyDispatcher: Agent;
  /** Recurring reconciliation/sweep timers; tests pass false. */
  startTimers?: boolean;
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
  const resolveActor = createJourneyUserResolver({
    clerkAuth: options.clerkAuth,
    syncJwtSecret: options.platformJwtSecret,
  });
  const authenticateRuntime = async ({ runtimeId, bearerToken }: { runtimeId: string; bearerToken: string }) => {
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
  };

  // S03: the Clerk membership projection is the only membership source. The
  // identifier resolver and (through the gateway client) the home precondition
  // consume it; without CLERK_SECRET_KEY nothing is ever verified and every
  // assertion stays negative.
  const organizations = await createPlatformOrganizations({
    db: options.db.kysely as unknown as Kysely<OrganizationPlatformDatabase>,
    ...(options.env.CLERK_SECRET_KEY ? { clerkSecretKey: options.env.CLERK_SECRET_KEY } : {}),
    ...(options.env.CLERK_ORGANIZATION_WEBHOOK_SIGNING_SECRET
      ? { webhookSigningSecret: options.env.CLERK_ORGANIZATION_WEBHOOK_SIGNING_SECRET }
      : {}),
    directory: {
      listRuntimeIdsForActor: async (actorId, limit) => {
        const rows = await (options.db.kysely as unknown as Kysely<CollaborationPlatformDatabase>)
          .selectFrom("collaboration_user_index as user_index")
          .innerJoin("collaboration_directory as directory", "directory.scope_id", "user_index.scope_id")
          .select("directory.runtime_id")
          .where("user_index.actor_id", "=", actorId)
          .where("user_index.status", "in", ["invited", "accepted"])
          .limit(limit)
          .execute();
        return rows.map((row) => row.runtime_id);
      },
    },
    resolveActor,
    authenticateRuntime,
    startTimers: options.startTimers ?? true,
  });

  const identifierResolver = new PlatformCollaborationIdentifierResolver({
    ...(options.env.CLERK_SECRET_KEY ? { clerkSecretKey: options.env.CLERK_SECRET_KEY } : {}),
    membershipProjection: organizations.projection,
    getAccountByActorId: async (actorId) => {
      const user = await getPlatformUserByClerkId(options.db, actorId);
      return user?.status === "active" ? { actorId: user.clerkId, displayName: user.displayName } : null;
    },
    listAccountsByUsername: async (username) => (await listActivePlatformUsersByNormalizedHandle(options.db, username))
      .map((user) => ({ actorId: user.clerkId, displayName: user.displayName })),
  });

  // S05: direct transport. The platform issues signed tickets and holds the
  // control stream; it never authorizes a resource request. Missing ticket
  // signing keys leave ticket issuance fail-closed without skipping construction.
  const relayOrigin = loadCollaborationRelayOrigin(options.env);
  if (!relayOrigin) return createFailClosedPlatformCollaboration({ reason: "origin_configuration_missing" });
  const collaborationDb = options.db.kysely as unknown as Kysely<CollaborationPlatformDatabase>;
  const direct = await createPlatformCollaborationDirect({
    db: options.db.kysely as unknown as Kysely<RuntimeEndpointPlatformDatabase>,
    repository: new PlatformCollaborationRepository(collaborationDb),
    controlAuthority: organizations.controlAuthority,
    projection: organizations.projection,
    keyring: loadTicketSigningKeyring(options.env),
    relayOrigin,
    resolveActor,
    authenticateRuntime,
    resolveRelayHandle: async (runtime) => {
      const machineId = parseVpsRuntimeId(runtime.runtimeId);
      const machine = machineId ? await getUserMachine(options.db, machineId) : undefined;
      return machine && machine.status === "running" && machine.clerkUserId === runtime.ownerId ? machine.handle : null;
    },
    resolveOrganization: async (scopeId) => (await new PlatformCollaborationRepository(collaborationDb).getDirectoryRoute(scopeId))?.organizationId ?? null,
    resolveRuntimeOrigin: async (runtimeId, ownerId) => {
      const machineId = parseVpsRuntimeId(runtimeId);
      const machine = machineId ? await getUserMachine(options.db, machineId) : undefined;
      if (!machine || machine.status !== "running" || !machine.publicIPv4 || machine.clerkUserId !== ownerId) return null;
      return `https://${machine.publicIPv4}:443`;
    },
    relayFetch: (input, init) => fetch(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(10_000),
      dispatcher: options.customerVpsProxyDispatcher,
    } as RequestInit & { dispatcher: import("undici").Dispatcher }),
  });

  const collaboration = await createPlatformCollaboration({
    db: collaborationDb,
    config,
    organizations,
    direct,
    resolveActor,
    authenticateRuntime,
    resolveParticipant: async (actorId) => {
      const user = await getPlatformUserByClerkId(options.db, actorId);
      return user ? { actorId, displayName: user.displayName } : null;
    },
    // Only current members of the scope's organization resolve (S20/S03); there is no
    // person-to-person path.
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
  return collaboration;
}

function parseVpsRuntimeId(runtimeId: string): string | null {
  const match = /^vps:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(runtimeId);
  return match?.[1] ?? null;
}
