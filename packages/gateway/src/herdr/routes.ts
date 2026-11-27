import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HerdrSessionIdSchema, type HerdrSessionList } from "@matrix-os/contracts/herdr-terminals";
import type { RequestPrincipal } from "../request-principal.js";
import { terminalRuntimeOwnerAccess } from "../shell/workspace-routes.js";
import { HerdrAdapterError, type HerdrAdapter } from "./adapter.js";

const DISABLED: HerdrSessionList = { available: false, status: "unavailable", sessions: [] };

/**
 * Herdr's sessions are the owner's own shells, so only the computer's owner
 * reaches them: no preview collaborators and no organization members.
 */
export function herdrOwnerAccess(principal: RequestPrincipal, terminalOwnerIds: readonly string[]) {
  return terminalRuntimeOwnerAccess(principal, terminalOwnerIds);
}

/** `/api/terminal/herdr`: list and end the owner's Herdr sessions (spec 2701). */
export function createHerdrRoutes(options: {
  adapter: HerdrAdapter | null;
  getPrincipal(context: Context): RequestPrincipal;
  terminalOwnerIds: readonly string[];
}): Hono {
  const app = new Hono();
  const deleteLimit = bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: "Request body is too large" }, 413) });

  async function ownerOnly(c: Context, next: () => Promise<void>) {
    const access = herdrOwnerAccess(options.getPrincipal(c), options.terminalOwnerIds);
    if (access === "unavailable") return c.json({ error: "Terminal operation unavailable" }, 503);
    if (access === "not_found") return c.json({ error: "Terminal operation failed" }, 404);
    await next();
  }

  app.get("/", ownerOnly, async (c) => {
    if (!options.adapter) return c.json(DISABLED);
    try {
      const view = c.req.query("view");
      if (view !== undefined && view !== "chat-control") return c.json({ error: "invalid_request" }, 400);
      return c.json(view === "chat-control" ? await options.adapter.listForChatControl() : await options.adapter.list());
    } catch (error: unknown) {
      console.error("[herdr] listing failed", error instanceof Error ? error.name : "unknown_error");
      return c.json(DISABLED);
    }
  });

  app.delete("/:id", deleteLimit, ownerOnly, async (c) => {
    const id = HerdrSessionIdSchema.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "Invalid request" }, 400);
    if (!options.adapter) return c.json({ error: "Terminal operation unavailable" }, 503);
    try {
      await options.adapter.kill(id.data);
      return c.json({ ok: true });
    } catch (error: unknown) {
      if (error instanceof HerdrAdapterError) {
        if (error.code === "not_found") return c.json({ error: "Terminal operation failed" }, 404);
        return c.json({ error: "Terminal operation unavailable" }, 503);
      }
      console.error("[herdr] ending a terminal failed", error instanceof Error ? error.name : "unknown_error");
      return c.json({ error: "Terminal operation failed" }, 500);
    }
  });

  return app;
}
