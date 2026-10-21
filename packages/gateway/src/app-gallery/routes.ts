import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { isRequestPrincipalError, mapRequestPrincipalError, requireRequestPrincipal } from "../request-principal.js";
import { createAppGalleryService, type AppGalleryOptions } from "./service.js";
import { GalleryError } from "./filesystem.js";

const IdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/);
const BodySchema = z.strictObject({});
export function registerAppGalleryRoutes(app: Hono, options: AppGalleryOptions & { ownerIds?: readonly string[] }): void {
  const service = createAppGalleryService(options);
  const owners = options.ownerIds ?? [process.env.MATRIX_USER_ID, process.env.MATRIX_CLERK_USER_ID].filter((id): id is string => Boolean(id));
  const authorize = (c: Context): void => {
    const principal = requireRequestPrincipal(c, { isLocalDevelopment: false });
    // No unauthenticated dev fallback: only explicit owner identities can access this bound home.
    if (!owners.includes(principal.userId)) throw new GalleryError(403, "Owner mismatch");
  };
  const failed = (c: Context, error: unknown) => {
    if (error instanceof Error && error.name === "BodyLimitError") return c.json({ error: "Request is too large" }, 413);
    if (isRequestPrincipalError(error)) {
      const mapped = mapRequestPrincipalError(error);
      if (mapped.log) console.error("[app-gallery] Principal configuration error", error);
      return c.json(mapped.body, mapped.status);
    }
    if (error instanceof GalleryError && error.status === 403) return c.json({ error: "Forbidden" }, 403);
    if (error instanceof GalleryError && error.status !== 503) return c.json({ error: error.status === 404 ? "App not found" : error.status === 400 ? "Invalid request" : "App folder is unavailable" }, error.status);
    console.error("[app-gallery] Request failed", error);
    return c.json({ error: "App gallery is temporarily unavailable" }, 503);
  };
  app.get("/api/app-gallery", async c => {
    try { authorize(c); return c.json({ version: 1, apps: await service.list() }); }
    catch (error) { return failed(c, error); }
  });
  app.post("/api/app-gallery/:id/install", bodyLimit({ maxSize: 4096, onError: c => c.json({ error: "Request is too large" }, 413) }), async c => {
    try {
      authorize(c);
      const id = IdSchema.safeParse(c.req.param("id"));
      if (!id.success) return c.json({ error: "Invalid app id" }, 400);
      let body: unknown;
      try { body = await c.req.json(); }
      catch (error) { if (error instanceof SyntaxError) return c.json({ error: "Invalid request body" }, 400); throw error; }
      if (!BodySchema.safeParse(body).success) return c.json({ error: "Invalid request body" }, 400);
      const result = await service.install(id.data);
      return c.json(result, result.status === "installed" ? 201 : 200);
    } catch (error) { return failed(c, error); }
  });
}
