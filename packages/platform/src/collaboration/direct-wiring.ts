/**
 * Direct-transport platform composition (S05 / T026).
 *
 * Builds the runtime endpoint directory, the ticket issuer (fail-closed
 * when signing keys are absent), the control stream and its upgrade
 * handler, and the routes. Registered and drained with the collaboration
 * runtime. Metadata only: nothing here forwards or parses customer payloads.
 */
import type { Context, Hono } from "hono";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Kysely } from "kysely";
import type { CollaborationControlAuthority } from "./control-authority.js";
import { CollaborationControlStream } from "./control-stream.js";
import { createCollaborationControlUpgradeHandler } from "./control-upgrade.js";
import { createPlatformCollaborationDirectRoutes, type AuthenticatedRuntime } from "./direct-routes.js";
import type { PlatformCollaborationRepository } from "./repository.js";
import {
  bootstrapPlatformRuntimeEndpointDatabase,
  CollaborationRuntimeEndpointRegistry,
  type RuntimeEndpointPlatformDatabase,
} from "./runtime-endpoints.js";
import { CollaborationTicketIssuer, loadTicketSigningKeyring, type TicketSigningKeyring } from "./ticket-issuer.js";
import { CollaborationRelay, type RelayHome } from "./relay.js";

export const DEFAULT_COLLABORATION_RELAY_ORIGIN = "https://app.matrix-os.com";

export interface PlatformCollaborationDirect {
  relay: CollaborationRelay;
  endpoints: CollaborationRuntimeEndpointRegistry;
  issuer: CollaborationTicketIssuer | null;
  controlStream: CollaborationControlStream;
  relayOrigin: string;
  register(app: Hono<any>): void;
  handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): Promise<boolean>;
  shutdown(): Promise<void>;
}

export function loadCollaborationRelayOrigin(env: NodeJS.ProcessEnv): string | null {
  const raw = env.MATRIX_COLLABORATION_RELAY_ORIGIN?.trim() || DEFAULT_COLLABORATION_RELAY_ORIGIN;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.origin !== raw) return null;
    return parsed.origin;
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) console.warn("[platform-collaboration] relay origin parse failed", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export async function createPlatformCollaborationDirect(options: {
  db: Kysely<RuntimeEndpointPlatformDatabase>;
  repository: PlatformCollaborationRepository;
  controlAuthority: Pick<CollaborationControlAuthority, "registerTransport" | "acknowledge">;
  projection: { isCurrentMember(input: { organizationId: string; actorId: string }): Promise<boolean> };
  keyring: TicketSigningKeyring | null;
  relayOrigin: string;
  resolveActor(c: Context): Promise<string | null>;
  authenticateRuntime(input: { runtimeId: string; bearerToken: string }): Promise<AuthenticatedRuntime | null>;
  resolveRelayHandle(runtime: AuthenticatedRuntime): Promise<string | null>;
  resolveOrganization(scopeId: string): Promise<string | null>;
  /** Maps an enrolled runtime (`vps:<uuid>`) to its relay-dialable origin; null when it is not running. */
  resolveRuntimeOrigin(runtimeId: string, ownerId: string): Promise<string | null>;
  relayFetch?: typeof fetch;
  now?: () => Date;
}): Promise<PlatformCollaborationDirect> {
  await bootstrapPlatformRuntimeEndpointDatabase(options.db);
  const endpoints = new CollaborationRuntimeEndpointRegistry(options.db, { now: options.now });
  let issuer: CollaborationTicketIssuer | null = null;
  if (options.keyring) {
    issuer = new CollaborationTicketIssuer({
      keyring: options.keyring,
      repository: options.repository,
      endpoints,
      resolveOrganization: options.resolveOrganization,
      projection: options.projection,
      relayOrigin: options.relayOrigin,
      now: options.now,
    });
  } else {
    console.warn("[platform-collaboration] ticket signing keys are not configured: connection tickets fail closed");
  }
  const homeFor = async (route: { runtimeId: string; ownerId: string } | null): Promise<RelayHome | null> => {
    if (!route) return null;
    const origin = await options.resolveRuntimeOrigin(route.runtimeId, route.ownerId);
    return origin ? { runtimeId: route.runtimeId, origin } : null;
  };
  const relay = new CollaborationRelay({
    resolveScopeHome: async (scopeId) => homeFor(await options.repository.getDirectoryRoute(scopeId)),
    resolveInvitationHome: async (actorId, invitationId) => homeFor(await options.repository.getInvitationRoute(actorId, invitationId)),
    resolveRuntimeHome: async (actorId, runtimeId) => {
      const origin = await options.resolveRuntimeOrigin(runtimeId, actorId);
      return origin ? { runtimeId, origin } : null;
    },
    // Session lifecycle routes name the home by the logical runtime id the ticket carries; the registry maps it back to enrollment.
    resolveSessionHome: async (logicalRuntimeId) => {
      const record = await endpoints.resolve(logicalRuntimeId);
      if (!record) return null;
      const enrolled = /^vps-([0-9a-f-]{36})$/.exec(logicalRuntimeId);
      const origin = await options.resolveRuntimeOrigin(enrolled ? `vps:${enrolled[1]}` : logicalRuntimeId, record.ownerId);
      return origin ? { runtimeId: logicalRuntimeId, origin } : null;
    },
    ...(options.relayFetch ? { fetchImpl: options.relayFetch } : {}),
  });
  const controlStream = new CollaborationControlStream({
    controlAuthority: options.controlAuthority,
    tickets: endpoints,
    onAttach: (runtimeId) => endpoints.heartbeat(runtimeId),
    now: options.now,
  });
  const upgrade = createCollaborationControlUpgradeHandler({ stream: controlStream, authenticateRuntime: options.authenticateRuntime });
  const routes = createPlatformCollaborationDirectRoutes({
    endpoints,
    issuer,
    controlStream,
    relayOrigin: options.relayOrigin,
    resolveActor: options.resolveActor,
    authenticateRuntime: options.authenticateRuntime,
    resolveRelayHandle: options.resolveRelayHandle,
  });
  let registered = false;
  let closing = false;
  return {
    relay,
    endpoints,
    issuer,
    controlStream,
    relayOrigin: options.relayOrigin,
    register(app) {
      if (registered || closing) throw new Error("Direct collaboration routes are already registered or shutting down");
      registered = true;
      app.route("/", routes);
    },
    handleUpgrade: (req, socket, head) => upgrade.handleUpgrade(req, socket, head),
    async shutdown() {
      if (closing) return;
      closing = true;
      upgrade.close();
      await controlStream.shutdown();
    },
  };
}

export { loadTicketSigningKeyring };
