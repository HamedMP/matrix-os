/**
 * Composition for the Matrix Core repo inside the platform process. Without
 * complete GitHub App config, object storage, or the organization projection,
 * the routes answer 503 and no job runs.
 */
import type { Context, Hono } from "hono";
import type { Kysely } from "kysely";
import { getActivePreviewMachineByHandle, getActivePrivatePreviewMachineByHandle } from "../customer-vps-preview.js";
import { getRunningUserMachineByHandle, type PlatformDB } from "../db.js";
import { buildPlatformVerificationToken, timingSafeTokenEquals } from "../platform-token.js";
import { parseCoreRepoConfig } from "./config.js";
import { bootstrapCoreRepoDatabase, createCoreRepoRepository, type CoreRepoDatabase } from "./database.js";
import { createGitHubCoreRepoClient } from "./github.js";
import { createCoreRepoRoutes, type CoreRepoRouteOptions } from "./routes.js";
import { createCoreRepoSyncService, type CoreRepoObjectStore } from "./service.js";

/**
 * The existing VPS machine credential: the handle's platform verification
 * token, accepted only for a running primary machine. Preview and Private
 * Preview machines never receive org content.
 */
export function createCoreRepoMachineAuthenticator(db: PlatformDB, platformSecret: string) {
  return async ({ handle, token }: { handle: string; token: string }): Promise<string | null> => {
    if (!platformSecret || !timingSafeTokenEquals(token, buildPlatformVerificationToken(handle, platformSecret))) return null;
    if (await getActivePreviewMachineByHandle(db, handle) || await getActivePrivatePreviewMachineByHandle(db, handle)) return null;
    return (await getRunningUserMachineByHandle(db, handle))?.clerkUserId ?? null;
  };
}

export async function createPlatformCoreRepo(options: {
  env: NodeJS.ProcessEnv;
  db: Kysely<CoreRepoDatabase>;
  store?: CoreRepoObjectStore;
  organizations?: CoreRepoRouteOptions["organizations"];
  authenticateMachine: CoreRepoRouteOptions["authenticateMachine"];
  resolveActor(c: Context): Promise<string | null>;
  /** The hourly job runs on one worker class; every instance serves routes and webhooks. */
  backgroundWorkers: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{ routes: Hono; shutdown(): Promise<void> }> {
  const config = parseCoreRepoConfig(options.env);
  const base = { authenticateMachine: options.authenticateMachine, resolveActor: options.resolveActor };
  if (!config || !options.store || !options.organizations) {
    if (config) console.warn("[core-repo] object storage or organizations unavailable: Matrix Core repo sync is off");
    return { routes: createCoreRepoRoutes(base), shutdown: async () => {} };
  }
  await bootstrapCoreRepoDatabase(options.db);
  const repository = createCoreRepoRepository(options.db);
  const github = createGitHubCoreRepoClient({ appId: config.appId, privateKey: config.privateKey, ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  const service = createCoreRepoSyncService({ config, github, store: options.store, repository });
  if (options.backgroundWorkers) service.start();
  return {
    routes: createCoreRepoRoutes({ ...base, service, repository, store: options.store, webhookSecret: config.webhookSecret, organizations: options.organizations }),
    shutdown: () => service.stop(),
  };
}
