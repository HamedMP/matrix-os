import type { Context, Hono } from "hono";
import type { Kysely } from "kysely";
import { bootstrapPlatformCollaborationDatabase, type CollaborationPlatformDatabase } from "./database.js";
import { CollaborationProofSigner } from "./proof.js";
import { CollaborationProxy, type CollaborationRuntimeRoute } from "./proxy.js";
import { PlatformCollaborationRepository } from "./repository.js";
import { createPlatformCollaborationRoutes } from "./routes.js";
import { CollaborationWebSocketAuthorizer } from "./websocket.js";

const MAX_PROOF_KEYS = 8;
const MAX_ALLOWED_ORIGINS = 16;

export interface PlatformCollaborationConfig {
  activeKeyId: string;
  proofKeys: Readonly<Record<string, string>>;
  allowedOrigins: readonly string[];
  enabledPurposes: readonly ["events"];
}

export function loadPlatformCollaborationConfig(env: NodeJS.ProcessEnv): PlatformCollaborationConfig | null {
  if (env.MATRIX_COLLABORATION_ENABLED !== "true") return null;
  const activeKeyId = env.MATRIX_COLLABORATION_ACTIVE_KEY_ID?.trim();
  const allowedOrigins = [...new Set((env.MATRIX_COLLABORATION_ALLOWED_ORIGINS ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean))];
  if (!activeKeyId || allowedOrigins.length < 1 || allowedOrigins.length > MAX_ALLOWED_ORIGINS) return null;
  let proofKeys: Record<string, string>;
  try {
    const parsed = JSON.parse(env.MATRIX_COLLABORATION_PROOF_KEYS ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    proofKeys = Object.fromEntries(Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ));
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[platform-collaboration] proof key configuration parse failed", error instanceof Error ? error.name : "UnknownError");
    }
    return null;
  }
  const keys = Object.entries(proofKeys);
  if (keys.length < 1 || keys.length > MAX_PROOF_KEYS
    || keys.some(([keyId, key]) => !/^[A-Za-z0-9_.-]{1,80}$/.test(keyId) || Buffer.byteLength(key) < 32)
    || !proofKeys[activeKeyId]) return null;
  try {
    const origins = allowedOrigins.map((value) => requireOrigin(value));
    return { activeKeyId, proofKeys, allowedOrigins: origins, enabledPurposes: ["events"] };
  } catch (error: unknown) {
    console.warn("[platform-collaboration] origin configuration rejected", error instanceof Error ? error.name : "UnknownError");
    return null;
  }
}

export async function createPlatformCollaboration(options: {
  db: Kysely<CollaborationPlatformDatabase>;
  config: PlatformCollaborationConfig;
  resolveActor(c: Context): Promise<string | null>;
  authenticateRuntime(input: {
    runtimeId: string;
    bearerToken: string;
  }): Promise<{ runtimeId: string; ownerId: string } | null>;
  resolveParticipant(actorId: string): Promise<{ actorId: string; displayName: string } | null>;
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
  const hydrate = async (input: { actorId: string; entry: import("./repository.js").CollaborationDirectoryEntry }) => {
    if (input.entry.status === "invited" && input.entry.invitationId) {
      return proxyJson(proxy, input.actorId, `/api/collaboration/invitations/${input.entry.invitationId}`);
    }
    if (input.entry.status === "accepted" && input.entry.kind === "chat") {
      const scopePath = `/api/collaboration/scopes/${input.entry.scopeId}`;
      const [scope, chat] = await Promise.all([
        proxyJson(proxy, input.actorId, scopePath),
        proxyJson(proxy, input.actorId, `${scopePath}/chat`),
      ]);
      return { scope, chat };
    }
    if (input.entry.status === "accepted" && input.entry.kind === "terminal") {
      const scopePath = `/api/collaboration/scopes/${input.entry.scopeId}`;
      const [scope, terminal] = await Promise.all([
        proxyJson(proxy, input.actorId, scopePath),
        proxyJson(proxy, input.actorId, `${scopePath}/terminal`),
      ]);
      return { scope, terminal };
    }
    if (input.entry.status === "accepted" && input.entry.kind === "project") {
      const scopePath = `/api/collaboration/scopes/${input.entry.scopeId}`;
      const [scope, project] = await Promise.all([
        proxyJson(proxy, input.actorId, scopePath),
        proxyJson(proxy, input.actorId, `${scopePath}/project`),
      ]);
      return { scope, project };
    }
    throw new Error("Collaboration projection unavailable");
  };
  const routes = createPlatformCollaborationRoutes({
    repository,
    signer,
    sockets,
    proxy,
    resolveActor: options.resolveActor,
    authenticateRuntime: options.authenticateRuntime,
    resolveParticipant: options.resolveParticipant,
    hydrate,
    now: options.now,
  });
  let registered = false;
  let closing = false;

  return {
    repository,
    signer,
    sockets,
    proxy,
    register(app: Hono<any>): void {
      if (registered || closing) throw new Error("Platform collaboration routes are already registered or shutting down");
      registered = true;
      app.route("/", routes);
    },
    async shutdown(): Promise<void> {
      if (closing) return;
      closing = true;
    },
  };
}

async function proxyJson(
  proxy: CollaborationProxy,
  actorId: string,
  path: string,
): Promise<unknown> {
  const response = await proxy.forward({
    actorId,
    method: "GET",
    path,
    query: "",
    body: new Uint8Array(),
    headers: new Headers({ accept: "application/json" }),
  });
  if (!response.ok) throw new Error("Collaboration projection unavailable");
  return response.json() as Promise<unknown>;
}

export type PlatformCollaborationRuntime = Awaited<ReturnType<typeof createPlatformCollaboration>>;

function requireOrigin(value: string): string {
  const parsed = new URL(value);
  if (!parsed.hostname || !["https:", "http:"].includes(parsed.protocol)
    || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
    || parsed.origin !== value) throw new Error("Invalid collaboration origin");
  return parsed.origin;
}
