import type { HonoRequest } from "hono";
import { appOrigin } from "./origins.js";

/** The route host has already passed the platform app-domain allowlist. */
export function resolveAuthShellBrowserHost(env: NodeJS.ProcessEnv, trustedRouteHost: string): string {
  const configuredOrigin = appOrigin(env);
  return configuredOrigin ? new URL(configuredOrigin).host : trustedRouteHost;
}

/**
 * Called only after the platform's bodyLimit middleware (10 MiB).
 * Read before the upstream-error catch so size-limit failures reach Hono's
 * 413 mapper instead of becoming an auth-shell availability error.
 */
export async function readAuthShellRequestBody(request: HonoRequest): Promise<Blob | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  return request.blob();
}
