/** Register the owner-only `GET /api/system/logs` route used by `matrix instance logs`. */
import type { Context, Hono } from "hono";
import {
  hasVerifiedRuntimeBearer, isRequestPrincipalError, readPrincipalRuntimeConfig, requireRequestPrincipal,
} from "../request-principal.js";
import { SystemLogsUnavailableError, parseSystemLogsQuery, type SystemLogReader } from "../system-logs.js";

export interface SystemLogRouteOptions {
  app: Hono;
  reader: SystemLogReader;
}

function isOwnerBearerRequest(c: Context): boolean {
  // Native bearer requests from the owner only. Browser cookies, dev-default
  // sessions, and scoped run tokens never carry verified runtime bearer proof.
  if (!hasVerifiedRuntimeBearer(c) || !c.req.header("authorization")?.startsWith("Bearer ")) return false;
  let principal;
  try {
    principal = requireRequestPrincipal(c);
  } catch (error: unknown) {
    if (!isRequestPrincipalError(error)) throw error;
    console.warn("[system-logs] request principal unavailable", error.name);
    return false;
  }
  if (principal.source === "dev-default") return false;
  const ownerId = readPrincipalRuntimeConfig().configuredUserId;
  return !ownerId || principal.userId === ownerId;
}

export function registerSystemLogRoutes(options: SystemLogRouteOptions): void {
  const { app, reader } = options;

  app.get("/api/system/logs", async (c) => {
    if (!isOwnerBearerRequest(c)) return c.json({ error: "Forbidden" }, 403);
    const parsed = parseSystemLogsQuery({
      service: c.req.query("service"),
      lines: c.req.query("lines"),
      since: c.req.query("since"),
    });
    if (!parsed.ok) return c.json({ error: "Invalid log request" }, 400);
    try {
      return c.json(await reader.read(parsed.query));
    } catch (error: unknown) {
      if (error instanceof SystemLogsUnavailableError) {
        return error.reason === "busy"
          ? c.json({ error: "Too many log requests" }, 429)
          : c.json({ error: "Logs are unavailable" }, 503);
      }
      throw error;
    }
  });
}
