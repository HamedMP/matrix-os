import { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { isIP } from "node:net";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { CanonicalChatIdSchema } from "@matrix-os/contracts";
import { requireRequestPrincipal, isRequestPrincipalError, mapRequestPrincipalError } from "../request-principal.js";
import { createRateLimiter } from "../security/rate-limiter.js";
import { ChatSharingError, ShareTokenSchema, type ChatSharing } from "./sharing.js";

const CreateSchema = z.object({ revision: z.number().int().nonnegative(), confirmed: z.literal(true), fingerprint: ShareTokenSchema }).strict();
export { shareHtml } from "@matrix-os/contracts";
import { shareHtml } from "@matrix-os/contracts";

export function createChatSharingRoutes(shares: ChatSharing | null) {
  const routes = new Hono();
  const limiter = createRateLimiter({ maxAttempts: 120, windowMs: 60_000, lockoutMs: 0, maxKeys: 10_000 });
  const capacity = createRateLimiter({ maxAttempts: 1200, windowMs: 60_000, lockoutMs: 0, maxKeys: 1 });
  const limit = bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: "Request too large" }, 413) });
  routes.use("/api/chats/:chatId/shares/*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  routes.get("/api/share/chats/:token", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("CDN-Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Robots-Tag", "noindex, nofollow");
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (!ShareTokenSchema.safeParse(c.req.param("token")).success) return c.text("Shared Chat unavailable", 404);
    let source = "unknown";
    try {
      const peer = getConnInfo(c).remote.address;
      if (peer && isIP(peer)) {
        source = peer;
        // Host nginx overwrites X-Real-IP. Trust it only over local transport;
        // direct network clients cannot choose a limiter key via headers.
        if (["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer)) {
          const forwarded = c.req.header("x-real-ip");
          if (forwarded && isIP(forwarded)) source = forwarded;
        }
      }
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) console.warn("[chat-sharing] transport unavailable", error instanceof Error ? error.name : "UnknownError");
    }
    if (!limiter.check(source) || !capacity.check("public")) return c.text("Try again later", 429);
    try {
      const snapshot = await shares?.read(c.req.param("token"));
      return snapshot ? (c.req.header("accept") === "application/json" ? c.json(snapshot) : c.html(shareHtml(snapshot))) : c.text("Shared Chat unavailable", shares ? 404 : 503);
    } catch (error: unknown) {
      console.warn("[chat-sharing] read failed", error instanceof Error ? error.name : "UnknownError");
      return c.text("Shared Chat unavailable", 503);
    }
  });
  routes.on(["GET", "POST", "DELETE"], ["/api/chats/:chatId/shares", "/api/chats/:chatId/shares/:shareId"], limit, async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const principal = requireRequestPrincipal(c);
      const owner = { type: "personal" as const, ownerId: principal.userId };
      const chatId = CanonicalChatIdSchema.parse(c.req.param("chatId"));
      if (!shares) return c.json({ error: "Sharing unavailable" }, 503);
      if (c.req.method === "DELETE") {
        await shares.revoke(owner, chatId, z.uuid().parse(c.req.param("shareId")));
        return c.json({ revoked: true });
      }
      if (c.req.method === "GET" && c.req.param("shareId") === "preview") return c.json(await shares.preview(owner, chatId));
      if (c.req.param("shareId")) return c.json({ error: "Not found" }, 404);
      if (c.req.method === "GET") return c.json({ shares: await shares.list(owner, chatId) });
      const input = CreateSchema.parse(await c.req.json());
      return c.json(await shares.create(owner, chatId, input.revision, input.fingerprint), 201);
    } catch (error: unknown) {
      if (isRequestPrincipalError(error)) {
        const mapped = mapRequestPrincipalError(error);
        return c.json(mapped.body, mapped.status);
      }
      if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: "Invalid share request" }, 400);
      if (error instanceof ChatSharingError) return c.json({ error: "Sharing unavailable", code: error.code }, error.code === "not_found" ? 404 : 409);
      console.warn("[chat-sharing] request failed", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Sharing unavailable" }, 503);
    }
  });
  return routes;
}
