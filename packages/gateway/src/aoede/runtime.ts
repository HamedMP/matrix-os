import type { Context } from "hono";
import type { WSContext } from "hono/ws";
import type { Kysely } from "kysely";
import type { AoedeServerMessage } from "@matrix-os/contracts";
import { wsConnectionsActive } from "../metrics.js";
import type { AppRegistry } from "../app-db-registry.js";
import type { RequestPrincipal } from "../request-principal.js";
import { listFacts } from "../vocal/profile.js";
import { createAoedeRepository } from "./repository.js";
import { loadAoedePlatformClient } from "./platform-client.js";
import { AoedeSessionError, createAoedeSessionService } from "./session.js";
import { createAoedeGatewayRoutes } from "./routes.js";
import { createAoedeDelegation } from "./delegate.js";

type DelegationOptions = Parameters<typeof createAoedeDelegation>[0];

/** Composition borrows the owner's pool; shutdown must precede Chat/pool teardown. */
export async function createAoedeRuntime(options: {
  env: NodeJS.ProcessEnv;
  homePath: string;
  database: Kysely<any> | null;
  registry: AppRegistry | null;
  chat: Omit<DelegationOptions, "ownerId" | "sessionRepository" | "actions"> | null;
  getPrincipal(c: Context): RequestPrincipal;
  clients: Set<WSContext>;
  clientOwnerIds: WeakMap<WSContext, string>;
  clientConnectionIds: WeakMap<WSContext, string>;
  broadcastToOwner(ownerId: string, message: AoedeServerMessage): void;
  notifyDataChange(ownerId: string, app: string): void;
}) {
  function emit(ownerId: string, message: AoedeServerMessage, connectionId?: string) {
    if (!connectionId) { options.broadcastToOwner(ownerId, message); return; }
    for (const ws of options.clients) {
      if (options.clientOwnerIds.get(ws) !== ownerId || options.clientConnectionIds.get(ws) !== connectionId) continue;
      try { ws.send(JSON.stringify(message)); }
      catch (error: unknown) {
        console.warn("[aoede/ws] send failed", error instanceof Error ? error.name : "UnknownError");
        if (options.clients.delete(ws)) wsConnectionsActive.dec();
      }
    }
  }
  const platform = loadAoedePlatformClient(options.env);
  if (!platform || !options.database || !options.registry || !options.chat) {
    return {
      routes: createAoedeGatewayRoutes({ getPrincipal: options.getPrincipal }),
      onClientMessage: async (_principal: RequestPrincipal, _connectionId: string, _raw: unknown) => { throw new AoedeSessionError(); },
      shutdown: async () => {},
    };
  }
  const repository = createAoedeRepository(options.database, platform);
  await repository.bootstrap();
  const delegation = createAoedeDelegation({
    ...options.chat, ownerId: platform.ownerId, sessionRepository: repository,
    actions: {
      homePath: options.homePath, database: options.database, registry: options.registry,
      notifyDataChange: app => options.notifyDataChange(platform.ownerId, app),
    },
  });
  const service = createAoedeSessionService({
    repository, platform, emit,
    facts: () => listFacts(options.homePath),
    dispatch: delegation.dispatch,
    onReady: delegation.seedRecentOutcomes,
    onBoundClientMessage: delegation.onClientMessage,
  });
  try { await service.recover(); }
  catch (error) {
    try { await service.shutdown(); } finally { await delegation.shutdown(); }
    throw error;
  }
  return {
    routes: createAoedeGatewayRoutes({ service, getPrincipal: options.getPrincipal }),
    onClientMessage: service.onClientMessage,
    async shutdown() { try { await service.shutdown(); } finally { await delegation.shutdown(); } },
  };
}
