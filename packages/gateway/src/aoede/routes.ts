import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { AoedeCloseRequestSchema, AoedeStartRequestSchema } from "@matrix-os/contracts";
import { isRequestPrincipalError, mapRequestPrincipalError, type RequestPrincipal } from "../request-principal.js";
import { AoedeConflictError } from "./repository.js";
import { AoedeSessionError, type AoedeSessionService } from "./session.js";

// Mount at /api/aoede behind existing gateway authentication. No new token allowance.
export function createAoedeGatewayRoutes(options: { service?: AoedeSessionService; getPrincipal(c: Context): RequestPrincipal }) {
  const app = new Hono();
  const principals = new WeakMap<Context, RequestPrincipal>();
  function failure(error: unknown, c: Context) {
    if (error instanceof HTTPException && error.status === 413) return c.json({ error: "Invalid voice request" }, 413);
    if (isRequestPrincipalError(error)) { const e = mapRequestPrincipalError(error); return c.json(e.body, e.status); }
    const status = error instanceof AoedeSessionError ? error.status : error instanceof AoedeConflictError ? 409 : 503;
    console.warn("[aoede] request failed", error instanceof Error ? error.name : "UnknownError");
    return c.json({ error: "Voice request failed" }, status);
  }
  app.onError(failure);
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store, private"); c.header("CDN-Cache-Control", "no-store");
    try {
      principals.set(c, options.getPrincipal(c));
      if (!options.service) return c.json({ error: "Voice is unavailable" }, 503);
      return await next();
    } finally { principals.delete(c); }
  });
  async function json(c: Context) {
    try { return await c.req.json(); }
    catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  }
  const limit = (maxSize: number) => bodyLimit({ maxSize, onError: (c) => c.json({ error: "Invalid voice request" }, 413) });
  app.post("/session", limit(64 * 1024), async (c) => {
    const input = AoedeStartRequestSchema.safeParse(await json(c));
    if (!input.success) return c.json({ error: "Invalid voice request" }, 400);
    return c.json(await options.service!.start(principals.get(c)!, input.data));
  });
  app.delete("/session", limit(1_024), async (c) => {
    const input = AoedeCloseRequestSchema.safeParse(await json(c));
    if (!input.success) return c.json({ error: "Invalid voice request" }, 400);
    await options.service!.close(principals.get(c)!, input.data.sessionId); return c.json({ ok: true });
  });
  app.get("/session", async (c) => c.json(await options.service!.snapshot(principals.get(c)!)));
  app.delete("/recovery", limit(1_024), async (c) => {
    await c.req.arrayBuffer(); await options.service!.clearRecovery(principals.get(c)!); return c.json({ ok: true });
  });
  return app;
}
