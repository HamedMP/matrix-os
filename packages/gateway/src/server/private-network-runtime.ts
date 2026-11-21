/**
 * Composition for the self-host private network (spec 2701): the identity
 * middleware that runs before bearer auth, the owner routes, and shutdown.
 * Managed computers get the middleware as a no-op and a route that reports
 * `supported: false`; no tables are created in their owner database.
 */
import type { Hono, MiddlewareHandler } from "hono";
import type { Kysely } from "kysely";
import { readPrivateNetworkConfig } from "../private-network/config.js";
import { OwnerLoginStore, createOwnerLoginLearner, privateNetworkIdentityMiddleware } from "../private-network/identity.js";
import { JoinCodeRegistry } from "../private-network/join-codes.js";
import { PairingStore, bootstrapPrivateNetworkDatabase, type PrivateNetworkDatabase } from "../private-network/pairing-store.js";
import { createPrivateNetworkRoutes } from "../private-network/routes.js";
import { TailscaleController } from "../private-network/tailscale-cli.js";

export interface PrivateNetworkRuntime {
  identity: MiddlewareHandler;
  routes: Hono;
  close(): void;
}

export async function createPrivateNetworkRuntime(input: {
  env: NodeJS.ProcessEnv;
  homePath: string;
  // The gateway's shared owner database; this runtime does not own or destroy it.
  db: Kysely<unknown> | null;
}): Promise<PrivateNetworkRuntime> {
  const config = readPrivateNetworkConfig(input.env);
  const ownerLogins = new OwnerLoginStore({ homePath: input.homePath, installLogin: config.installOwnerLogin });
  const tailscale = new TailscaleController({
    accessMode: config.accessMode,
    loginServer: config.loginServer,
    operator: config.runUser,
    bin: config.tailscaleBin,
  });
  const joinCodes = new JoinCodeRegistry();
  let store: PairingStore | null = null;
  if (config.selfHosted && input.db && config.accessMode !== "public") {
    const db = input.db as unknown as Kysely<PrivateNetworkDatabase>;
    try {
      await bootstrapPrivateNetworkDatabase(db);
      store = new PairingStore(db);
    } catch (error: unknown) {
      console.error("[private-network] Pairing tables unavailable; pairing disabled:", error instanceof Error ? error.name : "unknown");
    }
  }
  return {
    identity: privateNetworkIdentityMiddleware({
      accessMode: config.accessMode,
      ownerLogin: () => ownerLogins.get(),
      learnOwnerLogin: createOwnerLoginLearner({ ownerLogins, status: () => tailscale.status() }),
    }),
    routes: createPrivateNetworkRoutes({ config, tailscale, ownerLogins, joinCodes, store }),
    close() {
      tailscale.close();
      joinCodes.clear();
    },
  };
}
