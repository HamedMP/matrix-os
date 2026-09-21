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

export const DEFAULT_COLLABORATION_RELAY_ORIGIN = "https://app.matrix-os.com";

export interface PlatformCollaborationDirect {
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
  const controlStream = new CollaborationControlStream({ controlAuthority: options.controlAuthority, now: options.now });
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
