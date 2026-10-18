import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { isRequestPrincipalError, requireRequestPrincipal } from "../request-principal.js";
import { GallerySyncError } from "./sync-repository.js";
import type { GallerySyncService } from "./sync-service.js";
const AppId = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
/** Trusted hosts mediate this owner API; sandboxed app cookies cannot call it directly. */
export function createGallerySyncRoutes(options: { service: GallerySyncService | null; ownerIds: readonly string[] }) {
  const app = new Hono();
  const paths = ["/:appId/sync", "/:appId/sync/pause", "/:appId/sync/retry", "/:appId/sync/resume"];
  for (const path of paths) app.use(path, async (c, next) => {
    if (c.req.header("origin") === "null" || c.get("appSession" as never)) return c.json({ error: "Forbidden" }, 403);
    try { if (!options.ownerIds.includes(requireRequestPrincipal(c, { isLocalDevelopment: false }).userId)) return c.json({ error: "Forbidden" }, 403); }
    catch (error) { if (!isRequestPrincipalError(error)) console.error("[gallery-sync] Principal unavailable", error); return c.json({ error: "Forbidden" }, 403); }
    await next();
  });
  for (const path of paths) app.use(path, bodyLimit({ maxSize: 16384 }));
  app.all("/:appId/sync/*", async (c, next) => { if (!AppId.safeParse(c.req.param("appId")).success) return c.json({ error: "Invalid app" }, 400); await next(); });
  app.get("/:appId/sync", async c => {
    if (!AppId.safeParse(c.req.param("appId")).success) return c.json({ error: "Invalid app" }, 400);
    if (!options.service) return c.json({ error: "App sync is unavailable" }, 503);
    try { return c.json(await options.service.status(requireRequestPrincipal(c).userId, c.req.param("appId"))); }
    catch (error) { console.error("[gallery-sync] Status unavailable", error); return c.json({ error: "App sync is unavailable" }, 503); }
  });
  for (const action of ["start", "pause", "retry", "resume"] as const) {
    app.post(`/:appId/sync${action === "start" ? "" : `/${action}`}`, async c => {
      if (!AppId.safeParse(c.req.param("appId")).success) return c.json({ error: "Invalid app" }, 400);
      if (!options.service) return c.json({ error: "App sync is unavailable" }, 503);
      try {
        const body: unknown = await c.req.json();
        const ownerId = requireRequestPrincipal(c).userId, appId = c.req.param("appId");
        if (action !== "start" && !z.strictObject({}).safeParse(body).success) return c.json({ error: "Invalid request" }, 400);
        const result = action === "start" ? await options.service.start(ownerId, appId, body)
          : action === "pause" ? await options.service.pause(ownerId, appId)
          : await options.service.retry(ownerId, appId, action === "resume");
        return c.json(result, action === "pause" ? 200 : 202);
      } catch (error) {
        if (error instanceof Error && error.name === "BodyLimitError") return c.json({ error: "Request is too large" }, 413);
        if (error instanceof SyntaxError) return c.json({ error: "Invalid request" }, 400);
        if (error instanceof GallerySyncError) return c.json({ error: "App sync is unavailable" }, error.code === "invalid" ? 400 : error.code === "denied" ? 403 : error.code === "conflict" ? 409 : 503);
        console.error("[gallery-sync] Request unavailable", error); return c.json({ error: "App sync is unavailable" }, 503);
      }
    });
  }
  return app;
}
