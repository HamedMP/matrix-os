import type { HonoRequest } from "hono";

/**
 * Called only after the platform's bodyLimit middleware (10 MiB).
 * Read before the upstream-error catch so size-limit failures reach Hono's
 * 413 mapper instead of becoming an auth-shell availability error.
 */
export async function readAuthShellRequestBody(request: HonoRequest): Promise<Blob | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  return request.blob();
}
