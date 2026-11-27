import type { Hono } from "hono";
import { APP_FILES_BRIDGE_PATH } from "@matrix-os/contracts/app-files";
import { createAppFileRoutes } from "../app-files/routes.js";
import type { LegacyProjectPathAdmission } from "../collaboration/project-path-admission.js";
import { readPrincipalRuntimeConfig, requireRequestPrincipal } from "../request-principal.js";

export interface BridgeFileRouteOptions {
  homePath: string;
  /** Defaults to `process.env`; read once at registration. */
  env?: NodeJS.ProcessEnv;
  /** The owner file routes' collaboration fence; app writes into a shared or fenced project are refused. */
  projectPathAdmission?: LegacyProjectPathAdmission;
}

/**
 * Mounts `POST /api/bridge/files`. The owner set is the same one the app
 * capability route uses: the VPS owner from `MATRIX_USER_ID`, or
 * `MATRIX_CLERK_USER_ID` on hosts provisioned before it existed.
 */
export function registerBridgeFileRoutes(app: Hono, options: BridgeFileRouteOptions): void {
  const env = options.env ?? process.env;
  const ownerIds = [env.MATRIX_USER_ID, env.MATRIX_CLERK_USER_ID].filter((id): id is string => Boolean(id));
  const principalConfig = readPrincipalRuntimeConfig(env);
  app.route(APP_FILES_BRIDGE_PATH, createAppFileRoutes({
    homePath: options.homePath,
    ownerIds,
    resolveOwner: (context) => requireRequestPrincipal(context, principalConfig).userId,
    ...(options.projectPathAdmission ? { projectPathAdmission: options.projectPathAdmission } : {}),
  }));
}
