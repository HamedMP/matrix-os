import type { Context, Hono } from "hono";
import type { Kysely } from "kysely";
import { bootstrapPlatformCollaborationDatabase, type CollaborationPlatformDatabase } from "./database.js";
import { CollaborationProofSigner } from "./proof.js";
import { CollaborationProxy, type CollaborationRuntimeRoute } from "./proxy.js";
import { PlatformCollaborationRepository } from "./repository.js";
import { createPlatformCollaborationRoutes } from "./routes.js";
import { CollaborationWebSocketAuthorizer } from "./websocket.js";
import type { FailClosedPlatformCollaboration, PlatformCollaborationConfigurationFailure } from "./fail-closed.js";
import type { PlatformOrganizations } from "../organizations/wiring.js";
import type { PlatformCollaborationDirect } from "./direct-wiring.js";

export type { FailClosedPlatformCollaboration, PlatformCollaborationConfigurationFailure } from "./fail-closed.js";

const MAX_PROOF_KEYS = 8;
const MAX_ALLOWED_ORIGINS = 16;

export interface PlatformCollaborationConfig {
  activeKeyId: string;
  proofKeys: Readonly<Record<string, string>>;
  allowedOrigins: readonly string[];
  enabledPurposes: readonly ["events"];
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
  const activeKeyId = env.MATRIX_COLLABORATION_ACTIVE_KEY_ID?.trim();
  const allowedOrigins = [...new Set((env.MATRIX_COLLABORATION_ALLOWED_ORIGINS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean))];
  if (allowedOrigins.length < 1 || allowedOrigins.length > MAX_ALLOWED_ORIGINS) {
    return { configured: false, reason: "origin_configuration_missing" };
  }
  let proofKeys: Record<string, string>;
  try {
    const parsed = JSON.parse(env.MATRIX_COLLABORATION_PROOF_KEYS ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { configured: false, reason: "signing_configuration_missing" };
    }
    proofKeys = Object.fromEntries(Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ));
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[platform-collaboration] proof key configuration parse failed", error instanceof Error ? error.name : "UnknownError");
    }
    return { configured: false, reason: "signing_configuration_missing" };
  }
  const keys = Object.entries(proofKeys);
  if (!activeKeyId || keys.length < 1 || keys.length > MAX_PROOF_KEYS
    || keys.some(([keyId, key]) => !/^[A-Za-z0-9_.-]{1,80}$/.test(keyId) || Buffer.byteLength(key) < 32)
    || !proofKeys[activeKeyId]) {
    return { configured: false, reason: "signing_configuration_missing" };
  }
  try {
    const origins = allowedOrigins.map((value) => requireOrigin(value));
    return {
      configured: true,
      config: { activeKeyId, proofKeys, allowedOrigins: origins, enabledPurposes: ["events"] },
    };
  } catch (error: unknown) {
    console.warn("[platform-collaboration] origin configuration rejected", error instanceof Error ? error.name : "UnknownError");
    return { configured: false, reason: "origin_configuration_missing" };
  }
}

export async function createPlatformCollaboration(options: {
  db: Kysely<CollaborationPlatformDatabase>;
  config: PlatformCollaborationConfig;
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
  resolveRuntime(runtimeId: string): Promise<CollaborationRuntimeRoute | null>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}) {
  await bootstrapPlatformCollaborationDatabase(options.db);
  const repository = new PlatformCollaborationRepository(options.db, { now: options.now });
  const signer = new CollaborationProofSigner({
    activeKeyId: options.config.activeKeyId,
    keys: options.config.proofKeys,
    now: options.now,
  });
  const sockets = new CollaborationWebSocketAuthorizer({
    repository,
    signer,
    allowedOrigins: options.config.allowedOrigins,
    enabledPurposes: options.config.enabledPurposes,
    now: options.now,
  });
  const proxy = new CollaborationProxy({
    repository,
    signer,
    resolveRuntime: options.resolveRuntime,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  // S06 / T032: discovery is metadata-only; organization-wide shares are listed for current members.
  const organizations = options.organizations;
  const listOrganizationIds = organizations
    ? async (actorId: string) => (await organizations.repository.listOrganizationsForActor(actorId)).map((row) => row.organization.organizationId)
    : undefined;
  const routes = createPlatformCollaborationRoutes({
    repository,
    signer,
    sockets,
    proxy,
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
    signer,
    sockets,
    proxy,
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
