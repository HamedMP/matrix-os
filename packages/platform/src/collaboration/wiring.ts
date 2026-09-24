import type { Context, Hono } from "hono";
import type { Kysely } from "kysely";
import { bootstrapPlatformCollaborationDatabase, type CollaborationPlatformDatabase } from "./database.js";
import { PlatformCollaborationRepository } from "./repository.js";
import { createPlatformCollaborationRoutes } from "./routes.js";
import { loadCollaborationRelayOrigin } from "./direct-wiring.js";
import { loadTicketSigningKeyring, type TicketSigningKeyring } from "./ticket-issuer.js";
import type { FailClosedPlatformCollaboration, PlatformCollaborationConfigurationFailure } from "./fail-closed.js";
import type { PlatformOrganizations } from "../organizations/wiring.js";
import type { PlatformCollaborationDirect } from "./direct-wiring.js";

export type { FailClosedPlatformCollaboration, PlatformCollaborationConfigurationFailure } from "./fail-closed.js";

const MAX_ALLOWED_ORIGINS = 16;

export interface PlatformCollaborationConfig {
  /** Null when a present-but-unusable keyring leaves the ticket route unavailable; the platform still starts. */
  ticketKeyring: TicketSigningKeyring | null;
  relayOrigin: string;
  allowedOrigins: readonly string[];
}

export type PlatformCollaborationConfigurationHealth =
  | { configured: true; config: PlatformCollaborationConfig }
  | { configured: false; reason: PlatformCollaborationConfigurationFailure };

/** No release flag: incomplete configuration yields `null` and the composition root fails closed. */
export function loadPlatformCollaborationConfig(env: NodeJS.ProcessEnv): PlatformCollaborationConfig | null {
  const health = describePlatformCollaborationConfiguration(env);
  return health.configured ? health.config : null;
}

export function describePlatformCollaborationConfiguration(
  env: NodeJS.ProcessEnv,
): PlatformCollaborationConfigurationHealth {
  const relayOrigin = loadCollaborationRelayOrigin(env);
  if (!relayOrigin) return { configured: false, reason: "origin_configuration_missing" };
  const allowedOrigins = [...new Set((env.MATRIX_COLLABORATION_ALLOWED_ORIGINS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean))];
  if (allowedOrigins.length < 1 || allowedOrigins.length > MAX_ALLOWED_ORIGINS) {
    return { configured: false, reason: "origin_configuration_missing" };
  }
  let origins: string[];
  try {
    origins = allowedOrigins.map(requireOrigin);
  } catch (error: unknown) {
    console.warn("[platform-collaboration] origin configuration rejected", error instanceof Error ? error.name : "UnknownError");
    return { configured: false, reason: "origin_configuration_missing" };
  }
  // Absent ticket signing configuration is a platform misconfiguration. A configuration that is
  // present but unusable (mistimed rotation, stray retirement entry) costs the ticket route only:
  // the keyring loader documents that degradation, so do not promote it to a platform that will not start.
  if (!env.MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID?.trim() || !env.MATRIX_COLLABORATION_TICKET_KEYS?.trim()) {
    return { configured: false, reason: "signing_configuration_missing" };
  }
  return { configured: true, config: { ticketKeyring: loadTicketSigningKeyring(env), relayOrigin, allowedOrigins: origins } };
}

export async function createPlatformCollaboration(options: {
  db: Kysely<CollaborationPlatformDatabase>;
  /** S03 organization projection, control authority and routes; registered and drained with the runtime. */
  organizations?: PlatformOrganizations;
  /** S05 direct transport: runtime endpoints, tickets and the control stream; registered and drained with the runtime. */
  direct?: PlatformCollaborationDirect;
  resolveActor(c: Context): Promise<string | null>;
  authenticateRuntime(input: {
    runtimeId: string;
    bearerToken: string;
  }): Promise<{ runtimeId: string; ownerId: string } | null>;
  resolveParticipant(actorId: string): Promise<{ actorId: string; displayName: string } | null>;
  resolveInvitationIdentifier(identifier: string, organizationId: string): Promise<{ actorId: string; displayName: string } | null>;
  now?: () => Date;
}) {
  await bootstrapPlatformCollaborationDatabase(options.db);
  const repository = new PlatformCollaborationRepository(options.db, { now: options.now });
  // S06 / T032: discovery is metadata-only; organization-wide shares are listed for current members.
  const organizations = options.organizations;
  const listOrganizationIds = organizations
    ? async (actorId: string) => (await organizations.repository.listOrganizationsForActor(actorId)).map((row) => row.organization.organizationId)
    : undefined;
  const routes = createPlatformCollaborationRoutes({
    repository,
    ...(options.direct?.relay ? { relay: options.direct.relay } : {}),
    resolveActor: options.resolveActor,
    authenticateRuntime: options.authenticateRuntime,
    resolveParticipant: options.resolveParticipant,
    resolveInvitationIdentifier: options.resolveInvitationIdentifier,
    ...(listOrganizationIds ? { listOrganizationIds } : {}),
    now: options.now,
  });
  let registered = false;
  let closing = false;

  return {
    repository,
    organizations: options.organizations,
    direct: options.direct,
    register(app: Hono<any>): void {
      if (registered || closing) throw new Error("Platform collaboration routes are already registered or shutting down");
      registered = true;
      app.route("/", routes);
      options.organizations?.register(app);
      options.direct?.register(app);
    },
    async shutdown(): Promise<void> {
      if (closing) return;
      closing = true;
      await Promise.allSettled([options.direct?.shutdown(), options.organizations?.shutdown()]);
    },
  };
}


export type PlatformCollaborationRuntime = Awaited<ReturnType<typeof createPlatformCollaboration>>;
/** What the composition root always produces: the real runtime or the fail-closed registrar. */
export type PlatformCollaborationComposition = PlatformCollaborationRuntime | FailClosedPlatformCollaboration;

function requireOrigin(value: string): string {
  const parsed = new URL(value);
  if (!parsed.hostname || !["https:", "http:"].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
    || parsed.origin !== value) throw new Error("Invalid collaboration origin");
  return parsed.origin;
}
