import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { RefreshBindingSchema, RefreshNameSchema, IntegrationRefreshError } from "./contracts.js";
import { IntegrationRefreshService } from "./service.js";
import { createSafeDataUrlPreview } from "./url-preview.js";

/** Mount locally at /api/data-imports; integration provider routes can be platform-proxied. */
export function createIntegrationRefreshRoutes(options: {
  service: IntegrationRefreshService;
  resolveOwner: (c: Context) => Promise<string | null>;
  urlPreview?: ReturnType<typeof createSafeDataUrlPreview>;
}): Hono {
  const app = new Hono();
  const preview = options.urlPreview ?? createSafeDataUrlPreview();
  const failure = (c: Context, error: unknown) => {
    if (error instanceof IntegrationRefreshError) return c.json({ error: "Data import is unavailable" }, error.code === "denied" ? 403 : error.code === "conflict" ? 409 : error.code === "invalid" ? 400 : 503);
    console.warn("[data-imports] Request failed:", error instanceof Error ? error.name : "UnknownError");
    return c.json({ error: "Data import is unavailable" }, 503);
  };
  app.post("/url-preview", bodyLimit({ maxSize: 8192 }), async c => {
    const ownerId = await options.resolveOwner(c);
    if (!ownerId) return c.json({ error: "Unauthorized" }, 401);
    try {
      const parsed = z.strictObject({ url: z.string().min(1).max(2048) }).safeParse(await c.req.json());
      if (!parsed.success) throw new IntegrationRefreshError("invalid");
      return c.json(await preview(parsed.data.url));
    } catch (error: unknown) {
      if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON" }, 400);
      return failure(c, error);
    }
  });
  app.post("/refresh", bodyLimit({ maxSize: 32768 }), async c => {
    const ownerId = await options.resolveOwner(c);
    if (!ownerId) return c.json({ error: "Unauthorized" }, 401);
    try {
      const raw = await c.req.json();
      // restart is deliberately outside the immutable source binding.
      const restart = raw && typeof raw === "object" && "restart" in raw ? raw.restart : undefined;
      if (restart !== undefined && typeof restart !== "boolean") throw new IntegrationRefreshError("invalid");
      const binding = RefreshBindingSchema.safeParse(Object.fromEntries(Object.entries(raw ?? {}).filter(([key]) => key !== "restart")));
      if (!binding.success) throw new IntegrationRefreshError("invalid");
      return c.json(await options.service.refresh(ownerId, binding.data, { restart, signal: c.req.raw.signal }));
    } catch (error: unknown) {
      if (error instanceof SyntaxError) return c.json({ error: "Invalid JSON" }, 400);
      return failure(c, error);
    }
  });
  for (const includePages of [false, true]) {
    app.get(`/sources/:appId/:sourceId${includePages ? "/pages" : ""}`, async c => {
      const ownerId = await options.resolveOwner(c);
      if (!ownerId) return c.json({ error: "Unauthorized" }, 401);
      const appId = RefreshNameSchema.safeParse(c.req.param("appId"));
      const sourceId = RefreshNameSchema.safeParse(c.req.param("sourceId"));
      if (!appId.success || !sourceId.success) return c.json({ error: "Invalid request" }, 400);
      try { return c.json(await options.service.snapshot(ownerId, appId.data, sourceId.data, includePages)); }
      catch (error: unknown) { return failure(c, error); }
    });
  }
  app.delete("/sources/:appId/:sourceId", bodyLimit({ maxSize: 1024 }), async c => {
    const ownerId = await options.resolveOwner(c);
    if (!ownerId) return c.json({ error: "Unauthorized" }, 401);
    const appId = RefreshNameSchema.safeParse(c.req.param("appId"));
    const sourceId = RefreshNameSchema.safeParse(c.req.param("sourceId"));
    if (!appId.success || !sourceId.success) return c.json({ error: "Invalid request" }, 400);
    try { return c.json(await options.service.remove(ownerId, appId.data, sourceId.data)); }
    catch (error: unknown) { return failure(c, error); }
  });
  return app;
}
