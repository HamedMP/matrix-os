import type { Kysely } from "kysely";
import type { Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { CollaborationActorProofVerifier } from "./actor-proof.js";
import { CollaborationAuthority } from "./authority.js";
import { CollaborationChatAdapter } from "./chat-adapter.js";
import { CollaborationChatScopeService } from "./chat-scope.js";
import { bootstrapCollaborationDatabase, type OwnerCollaborationDatabase } from "./database.js";
import { CollaborationDirectoryOutbox } from "./directory-outbox.js";
import { registerCollaborationEventWebSocketRoute } from "./event-websocket-route.js";
import { CollaborationEventRegistry } from "./events.js";
import { CollaborationParticipantResolver } from "./participant-resolver.js";
import { CollaborationRepository } from "./repository.js";
import { createCollaborationRoutes } from "./routes.js";

const MAX_PROOF_KEYS = 8;
const MACHINE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface GatewayCollaborationConfig {
  runtimeId: string;
  activeKeyId: string;
  proofKeys: Readonly<Record<string, string>>;
  preflightSecret: string;
  platformBaseUrl: string;
  serviceToken: string;
}

export function loadGatewayCollaborationConfig(env: NodeJS.ProcessEnv): GatewayCollaborationConfig | null {
  if (env.MATRIX_COLLABORATION_ENABLED !== "true") return null;
  const configuredRuntimeId = env.MATRIX_RUNTIME_ID?.trim();
  const machineId = env.MATRIX_MACHINE_ID?.trim();
  const runtimeId = configuredRuntimeId
    || (machineId && MACHINE_ID_PATTERN.test(machineId) ? `vps:${machineId.toLowerCase()}` : undefined);
  const activeKeyId = env.MATRIX_COLLABORATION_ACTIVE_KEY_ID?.trim();
  const preflightSecret = env.MATRIX_COLLABORATION_PREFLIGHT_SECRET;
  const platformBaseUrl = env.PLATFORM_INTERNAL_URL?.trim();
  const serviceToken = env.UPGRADE_TOKEN;
  if (!runtimeId || !activeKeyId || !preflightSecret || !platformBaseUrl || !serviceToken) return null;
  let proofKeys: Record<string, string>;
  try {
    const parsed = JSON.parse(env.MATRIX_COLLABORATION_PROOF_KEYS ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    proofKeys = Object.fromEntries(Object.entries(parsed).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ));
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[collaboration] proof key configuration parse failed", error instanceof Error ? error.name : "UnknownError");
    }
    return null;
  }
  const entries = Object.entries(proofKeys);
  if (entries.length < 1 || entries.length > MAX_PROOF_KEYS
    || entries.some(([keyId, key]) => !/^[A-Za-z0-9_.-]{1,80}$/.test(keyId) || Buffer.byteLength(key) < 32)
    || !proofKeys[activeKeyId] || Buffer.byteLength(preflightSecret) < 32 || Buffer.byteLength(serviceToken) < 32) {
    return null;
  }
  return { runtimeId, activeKeyId, proofKeys, preflightSecret, platformBaseUrl, serviceToken };
}

export async function createGatewayCollaboration(options: {
  db: Kysely<OwnerCollaborationDatabase>;
  config: GatewayCollaborationConfig;
  resolveParticipant?(actorId: string): Promise<{ actorId: string; displayName: string }>;
  outboxFetch?: typeof fetch;
  startTimers?: boolean;
}) {
  await bootstrapCollaborationDatabase(options.db);
  await options.db.deleteFrom("collaboration_operations")
    .where("expires_at", "<=", new Date().toISOString())
    .execute();
  const repository = new CollaborationRepository(options.db);
  const participantResolver = options.resolveParticipant ? undefined : new CollaborationParticipantResolver({
    platformBaseUrl: options.config.platformBaseUrl,
    runtimeId: options.config.runtimeId,
    serviceToken: options.config.serviceToken,
  });
  const resolveParticipant = options.resolveParticipant
    ?? ((actorId: string) => participantResolver!.resolve(actorId));
  const authority = new CollaborationAuthority(repository);
  const verifier = new CollaborationActorProofVerifier({
    runtimeId: options.config.runtimeId,
    keys: options.config.proofKeys,
    authority,
  });
  const chatScope = new CollaborationChatScopeService(options.db, {
    runtimeId: options.config.runtimeId,
    preflightSecret: options.config.preflightSecret,
  });
  const outbox = new CollaborationDirectoryOutbox({
    db: options.db,
    platformBaseUrl: options.config.platformBaseUrl,
    runtimeId: options.config.runtimeId,
    serviceToken: options.config.serviceToken,
    ...(options.outboxFetch ? { fetchImpl: options.outboxFetch } : {}),
    startTimer: options.startTimers,
  });
  const eventRegistry = new CollaborationEventRegistry({
    db: options.db,
    authorize: (scopeId, actorId) => authority.authorize({ scopeId, actorId, action: "read" }),
    startTimers: options.startTimers,
  });
  const chatAdapter = new CollaborationChatAdapter({
    db: options.db,
    authority,
    resolveParticipant,
    onCommitted: (scopeId) => eventRegistry.broadcastScope(scopeId),
  });
  let registered = false;
  let closing = false;

  return {
    repository,
    authority,
    verifier,
    eventRegistry,
    chatScope,
    chatAdapter,
    outbox,
    collaborationGuard: chatScope,
    register(input: { app: Hono; upgradeWebSocket: UpgradeWebSocket }): void {
      if (registered || closing) throw new Error("Collaboration routes are already registered or shutting down");
      registered = true;
      input.app.route("/", createCollaborationRoutes({
        runtimeId: options.config.runtimeId,
        verifier,
        authority,
        repository,
        chatScope,
        chatAdapter,
        resolveParticipant,
        onScopeCommitted: (scopeId) => eventRegistry.broadcastScope(scopeId),
        onRevoked: (scopeId, actorId) => eventRegistry.notifyRevoked(scopeId, actorId),
      }));
      registerCollaborationEventWebSocketRoute({
        app: input.app,
        upgradeWebSocket: input.upgradeWebSocket,
        verifier,
        authority,
        registry: eventRegistry,
      });
    },
    async shutdown(): Promise<void> {
      if (closing) return;
      closing = true;
      eventRegistry.shutdown();
      await outbox.shutdown();
      participantResolver?.shutdown();
      verifier.shutdown();
    },
  };
}

export type GatewayCollaborationRuntime = Awaited<ReturnType<typeof createGatewayCollaboration>>;
