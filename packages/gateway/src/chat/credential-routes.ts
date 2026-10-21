import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { CanonicalChatIdSchema } from "@matrix-os/contracts";
import { createRateLimiter } from "../security/rate-limiter.js";
import { isRequestPrincipalError, mapRequestPrincipalError, type RequestPrincipal } from "../request-principal.js";
import { ChatCredentialUnavailableError, type ChatCredentialRepository } from "./credential-repository.js";

const MessageIds = z.string().min(1).max(8_255).transform((value) => value.split(","))
  .pipe(z.array(z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)).min(1).max(64));
const OccurrenceId = z.string().regex(/^cred_[a-f0-9]{32}$/);
const mutationBodyLimit = bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: "Credential unavailable" }, 413) });

function fail(c: Context, error: unknown) {
  if (isRequestPrincipalError(error)) {
    const mapped = mapRequestPrincipalError(error, "Credential unavailable");
    return c.json(mapped.body, mapped.status);
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: "Invalid request" }, 400);
  if (error instanceof ChatCredentialUnavailableError) return c.json({ error: "Credential unavailable" }, 404);
  console.warn("[chat/credentials] request failed", error instanceof Error ? error.name : "UnknownError");
  return c.json({ error: "Credential unavailable" }, 503);
}

export function createChatCredentialRoutes(options: {
  repository: ChatCredentialRepository | null;
  getPrincipal: (context: Context) => RequestPrincipal;
}) {
  const routes = new Hono();
  const limiter = createRateLimiter({ maxAttempts: 120, windowMs: 60_000, lockoutMs: 0, maxKeys: 10_000 });
  routes.use("/api/chats/:chatId/credentials/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });
  routes.get("/api/chats/:chatId/credentials", async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const principal = options.getPrincipal(c);
      if (!limiter.check(principal.userId)) return c.json({ error: "Credential unavailable" }, 429);
      const chatId = CanonicalChatIdSchema.parse(c.req.param("chatId"));
      const messageIds = MessageIds.parse(c.req.query("messageIds"));
      if (!options.repository) throw new ChatCredentialUnavailableError();
      return c.json({ occurrences: await options.repository.list({ type: "personal", ownerId: principal.userId }, chatId, messageIds) });
    } catch (error: unknown) { return fail(c, error); }
  });
  routes.get("/api/chats/:chatId/credentials/:occurrenceId/value", async (c) => {
    try {
      const principal = options.getPrincipal(c);
      if (!limiter.check(principal.userId)) return c.json({ error: "Credential unavailable" }, 429);
      const chatId = CanonicalChatIdSchema.parse(c.req.param("chatId"));
      const occurrenceId = OccurrenceId.parse(c.req.param("occurrenceId"));
      if (!options.repository) throw new ChatCredentialUnavailableError();
      return c.json(await options.repository.value({ type: "personal", ownerId: principal.userId }, chatId, occurrenceId));
    } catch (error: unknown) { return fail(c, error); }
  });
  async function mutate(c: Context, action: "reveal" | "hide") {
    try {
      const principal = options.getPrincipal(c);
      if (!limiter.check(principal.userId)) return c.json({ error: "Credential unavailable" }, 429);
      const chatId = CanonicalChatIdSchema.parse(c.req.param("chatId"));
      const occurrenceId = OccurrenceId.parse(c.req.param("occurrenceId"));
      const body = await c.req.text();
      if (body && (body !== "{}" || body.length > 2)) return c.json({ error: "Invalid request" }, 400);
      if (!options.repository) throw new ChatCredentialUnavailableError();
      const owner = { type: "personal" as const, ownerId: principal.userId };
      return c.json(action === "reveal"
        ? await options.repository.reveal(owner, chatId, occurrenceId)
        : await options.repository.hide(owner, chatId, occurrenceId));
    } catch (error: unknown) { return fail(c, error); }
  }
  routes.post("/api/chats/:chatId/credentials/:occurrenceId/reveal", mutationBodyLimit, (c) => mutate(c, "reveal"));
  routes.post("/api/chats/:chatId/credentials/:occurrenceId/hide", mutationBodyLimit, (c) => mutate(c, "hide"));
  return routes;
}
