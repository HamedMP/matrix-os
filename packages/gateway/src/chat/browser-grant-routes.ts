import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { BrowserGrantRevokeRequestSchema, BrowserGrantViewSchema, CanonicalChatIdSchema } from "@matrix-os/contracts";
import type { BrowserApprovalControl } from "./browser-approval-control.js";
import type { RequestPrincipal } from "../request-principal.js";

/** Owner metadata reads; Undo additionally needs the independently signed intent. */
export function createBrowserGrantRoutes(options: { control?: BrowserApprovalControl; getPrincipal(context: Context): RequestPrincipal }) {
  const app = new Hono();
  app.get("/api/chats/:chatId/browser-grants", async c => {
    const chat = CanonicalChatIdSchema.safeParse(c.req.param("chatId"));
    if (!chat.success) return c.json({ error: "Invalid request" }, 400);
    if (!options.control) return c.json({ error: "Unavailable" }, 503);
    try {
      const grant = await options.control.activeGrant(options.getPrincipal(c).userId, chat.data);
      return c.json({ grant: grant ? BrowserGrantViewSchema.parse(grant) : null }, 200, { "Cache-Control": "no-store" });
    } catch (error: unknown) {
      console.warn("[browser-approval] Grant read unavailable", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Browser permission unavailable" }, 503);
    }
  });
  app.delete("/api/chats/:chatId/browser-grants/:grantId", bodyLimit({ maxSize: 4000 }), async c => {
    const chat = CanonicalChatIdSchema.safeParse(c.req.param("chatId")), grant = z.uuid().safeParse(c.req.param("grantId"));
    if (!chat.success || !grant.success) return c.json({ error: "Invalid request" }, 400);
    if (!options.control) return c.json({ error: "Unavailable" }, 503);
    try {
      const input = BrowserGrantRevokeRequestSchema.safeParse(await c.req.json());
      if (!input.success) return c.json({ error: "Invalid request" }, 400);
      const proof = c.req.header("x-matrix-browser-approval-proof");
      if (!proof) return c.json({ error: "Browser permission unavailable" }, 403);
      const revoked = await options.control.revokeGrant({ ownerId: options.getPrincipal(c).userId, chatId: chat.data,
        grantId: grant.data, input: input.data, proof });
      return c.json({ grant: BrowserGrantViewSchema.parse(revoked) }, 200, { "Cache-Control": "no-store" });
    } catch (error: unknown) {
      if (error instanceof SyntaxError) return c.json({ error: "Invalid request" }, 400);
      console.warn("[browser-approval] Grant revoke unavailable", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Browser permission unavailable" }, 503);
    }
  });
  return app;
}
