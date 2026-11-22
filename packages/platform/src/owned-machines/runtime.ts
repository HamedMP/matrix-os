import { Hono } from 'hono';
import type { ClerkAuth } from '../clerk-auth.js';
import type { PlatformDB } from '../db.js';
import { createOwnedCloudflareClient } from './cloudflare.js';
import { loadOwnedMachinesConfig, type OwnedMachinesConfig } from './config.js';
import { createOwnedMachineRoutes } from './machine-routes.js';
import { createOwnedOwnerRoutes } from './owner-routes.js';
import type { OwnedRevocationHook } from './repository.js';
import { startOwnedTunnelWorker, type OwnedTunnelWorker } from './tunnel-worker.js';

export interface OwnedMachinesRuntime {
  routes: Hono;
  config: OwnedMachinesConfig | null;
  shutdown(): Promise<void>;
}

/**
 * Builds the owned-machines feature once at startup. A disabled feature mounts
 * nothing; a partial configuration mounts routes that answer 503, so owners
 * never see a misconfiguration as a missing computer.
 */
export function createOwnedMachinesRuntime(deps: {
  db: PlatformDB;
  env: NodeJS.ProcessEnv;
  clerkAuth?: ClerkAuth;
  platformJwtSecret: string;
  base: Parameters<typeof loadOwnedMachinesConfig>[1];
  backgroundWorkersEnabled: boolean;
  resolveHandle: (clerkUserId: string) => Promise<string | null>;
  revocationHooks?: readonly OwnedRevocationHook[];
  log: (route: string, err: unknown) => void;
}): OwnedMachinesRuntime | null {
  const loaded = loadOwnedMachinesConfig(deps.env, deps.base);
  if (loaded.status === 'disabled') return null;
  if (loaded.status === 'misconfigured') {
    console.error(`[owned-machines] disabled: incomplete configuration (${loaded.missing.join(', ')})`);
  }
  const config = loaded.status === 'ready' ? loaded.config : null;
  const cloudflare = config ? createOwnedCloudflareClient(config.cloudflare) : null;
  const routes = new Hono();
  routes.route('/', createOwnedMachineRoutes({
    db: deps.db, config, cloudflare, edgeSecret: deps.env.EDGE_ROUTER_SECRET,
    revocationHooks: deps.revocationHooks, log: deps.log,
  }));
  routes.route('/', createOwnedOwnerRoutes({
    db: deps.db, config, clerkAuth: deps.clerkAuth, platformJwtSecret: deps.platformJwtSecret,
    publishableKey: deps.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,
    resolveHandle: deps.resolveHandle, revocationHooks: deps.revocationHooks, log: deps.log,
  }));
  let worker: OwnedTunnelWorker | undefined;
  if (config && cloudflare && deps.backgroundWorkersEnabled) {
    worker = startOwnedTunnelWorker({
      db: deps.db, cloudflare, hostSuffix: config.hostSuffix, hostPrefix: config.hostPrefix, ingressService: config.ingressService,
      log: (message, err) => deps.log(message, err),
    });
  }
  return {
    routes,
    config,
    async shutdown() {
      worker?.stop();
      await worker?.drain();
    },
  };
}
