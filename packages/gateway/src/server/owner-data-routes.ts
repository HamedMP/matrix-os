import { loadHandle } from "@matrix-os/kernel";
import type { Hono } from "hono";
import type { AppDb } from "../app-db.js";
import type { QueryEngine } from "../app-db-query.js";
import type { MessagingRepository } from "../messages/repository.js";
import { createMessagingRoutes } from "../messages/routes.js";
import { requireRequestPrincipal } from "../request-principal.js";
import { bootstrapSocialSchema, createSocialRoutes } from "../social.js";
import type { HomeMirrorReadinessStatus } from "../sync/home-mirror-readiness.js";
import { createSyncRoutes, createUnconfiguredSyncRoutes, type SyncRouteDeps } from "../sync/routes.js";

export function registerGatewayMessagingRoutes(app: Hono, messagingRepository: MessagingRepository | null): void {
  if (messagingRepository) {
    app.route("/api/messages", createMessagingRoutes({
      repository: messagingRepository,
      getOwnerId: (c) => requireRequestPrincipal(c).userId,
      appserviceToken: process.env.MATRIX_MESSAGING_APPSERVICE_TOKEN,
      appserviceOwnerId: process.env.MATRIX_MESSAGING_APPSERVICE_OWNER_ID ?? process.env.MATRIX_USER_ID ?? process.env.MATRIX_HANDLE,
      hermesCapabilitySecret: process.env.MATRIX_MESSAGING_HERMES_CAPABILITY_SECRET,
    }));
  } else {
    app.all("/api/messages/*", (c) => c.json({ error: { code: "misconfigured", message: "Messaging is not configured" } }, 503));
    app.all("/api/messages", (c) => c.json({ error: { code: "misconfigured", message: "Messaging is not configured" } }, 503));
  }
}

export async function registerGatewaySyncAndSocialRoutes(options: {
  app: Hono;
  appDb: AppDb | null;
  homePath: string;
  queryEngine: QueryEngine | null;
  syncDeps: SyncRouteDeps | null;
  getHomeMirrorStatus(): HomeMirrorReadinessStatus;
}) {
  const { app, appDb, homePath, queryEngine, syncDeps, getHomeMirrorStatus } = options;
  if (syncDeps) {
    app.route("/api/sync", createSyncRoutes({
      ...syncDeps,
      getHomeMirrorStatus,
    }));
  } else {
    app.route("/api/sync", createUnconfiguredSyncRoutes({
      getHomeMirrorStatus,
    }));
  }

  const getCurrentUser = () => {
    const identity = loadHandle(homePath);
    return identity.handle || "@me";
  };
  if (appDb && queryEngine) {
    await bootstrapSocialSchema(appDb);
    const socialRoutes = createSocialRoutes(appDb, queryEngine, getCurrentUser);
    app.route("/api/social", socialRoutes);
    return socialRoutes;
  }
  app.all("/api/social/*", (c) => c.json({ error: "Database not configured (no DATABASE_URL)" }, 503));
  return undefined;
}
