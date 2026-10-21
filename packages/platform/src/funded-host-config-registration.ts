import type { Hono } from "hono";
import type { PlatformDB } from "./db.js";
import { createFundedHostConfigRoutes, loadFundedHostConfig } from "./funded-host-config.js";

/** Mount before tenant routing: machine Sync tokens are not owner sessions. */
export function registerFundedHostConfigRoutes(app: Hono<any>, options: {
  db: PlatformDB; platformSecret: string; env: NodeJS.ProcessEnv;
}) {
  const config = loadFundedHostConfig(options.env);
  if (!config.enabled) return;
  const routes = createFundedHostConfigRoutes({ db: options.db, platformSecret: options.platformSecret, config, env: options.env });
  app.route("/internal/containers/:handle", routes);
}
