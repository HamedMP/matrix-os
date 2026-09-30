import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { CollaborationAuthorizationError } from "../collaboration/authority-error.js";
import { isRequestPrincipalError, mapRequestPrincipalError, MissingRequestPrincipalError, requireRequestPrincipal, type PrincipalRuntimeConfig } from "../request-principal.js";
import { BrainRevisionSchema, BrainScopeIdSchema, BrainSourceIdSchema, PublishBrainSourceSchema, SearchBrainSchema } from "./schemas.js";
import { CompanyBrainError, type CompanyBrainService } from "./service.js";

export interface CompanyBrainRouteOptions {
  service: CompanyBrainService;
  principalConfig?: Partial<PrincipalRuntimeConfig>;
}

/** Mount behind gateway auth. Identity comes only from the trusted request principal. */
export function createCompanyBrainRoutes(options: CompanyBrainRouteOptions): Hono {
  const app = new Hono();
  const limit = bodyLimit({ maxSize: 140_000, onError: (c) => c.json({ error: "Request too large" }, 413) });
  app.onError((caught, c) => {
    const error: unknown = caught;
    if (isRequestPrincipalError(error)) {
      const mapped = mapRequestPrincipalError(error, "Company Brain unavailable");
      if (mapped.log) console.warn("[company-brain] principal initialization failed");
      return c.json(mapped.body, mapped.status);
    }
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: "Invalid Company Brain request" }, 400);
    if (error instanceof CompanyBrainError || error instanceof CollaborationAuthorizationError) {
      const status = error.code === "not_found" ? 404 : error.code === "forbidden" ? 403
        : error.code === "conflict" ? 409 : error.code === "capacity" ? 429 : 503;
      return c.json({ error: "Company Brain unavailable", code: error.code }, status);
    }
    console.warn("[company-brain] request failed", error instanceof Error ? error.name : "UnknownError");
    return c.json({ error: "Company Brain unavailable" }, 503);
  });
  app.use("*", async (c, next) => {
    const principal = requireRequestPrincipal(c, options.principalConfig);
    if (principal.source === "dev-default") throw new MissingRequestPrincipalError();
    await next();
  });
  const actor = (c: Parameters<typeof requireRequestPrincipal>[0]) => requireRequestPrincipal(c, options.principalConfig).userId;

  app.post("/scopes/:scopeId/sources", limit, async (c) => {
    const scopeId = BrainScopeIdSchema.parse(c.req.param("scopeId"));
    const source = PublishBrainSourceSchema.parse(await c.req.json());
    return c.json(await options.service.publish(scopeId, actor(c), source), 201);
  });
  app.get("/scopes/:scopeId/search", async (c) => {
    const scopeId = BrainScopeIdSchema.parse(c.req.param("scopeId"));
    const query = SearchBrainSchema.parse({ query: c.req.query("q"), limit: c.req.query("limit") === undefined ? 5 : Number(c.req.query("limit")) });
    return c.json({ sources: await options.service.search(scopeId, actor(c), query) });
  });
  app.get("/scopes/:scopeId/sources/:sourceId", async (c) => {
    const scopeId = BrainScopeIdSchema.parse(c.req.param("scopeId"));
    const sourceId = BrainSourceIdSchema.parse(c.req.param("sourceId"));
    return c.json(await options.service.get(scopeId, actor(c), sourceId));
  });
  app.get("/scopes/:scopeId/export", async (c) => {
    const scopeId = BrainScopeIdSchema.parse(c.req.param("scopeId"));
    return c.json(await options.service.export(scopeId, actor(c)));
  });
  app.delete("/scopes/:scopeId/sources/:sourceId", limit, async (c) => {
    const scopeId = BrainScopeIdSchema.parse(c.req.param("scopeId"));
    const sourceId = BrainSourceIdSchema.parse(c.req.param("sourceId"));
    await c.req.arrayBuffer(); // Consume the middleware-bounded body even when DELETE ignores its contents.
    const rawRevision = c.req.query("expectedRevision");
    const revision = BrainRevisionSchema.parse(rawRevision === undefined || rawRevision.trim() === "" ? undefined : Number(rawRevision));
    await options.service.remove(scopeId, actor(c), sourceId, revision);
    return c.json({ deleted: true });
  });
  app.delete("/scopes/:scopeId", limit, async (c) => {
    const scopeId = BrainScopeIdSchema.parse(c.req.param("scopeId"));
    await c.req.arrayBuffer();
    await options.service.erase(scopeId, actor(c));
    return c.json({ deleted: true });
  });
  return app;
}
