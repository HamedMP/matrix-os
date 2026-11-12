import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { CanonicalChatIdSchema, CanonicalSideChatSnapshotSchema, CanonicalSideChatTurnRequestSchema } from "@matrix-os/contracts";
import { isRequestPrincipalError, mapRequestPrincipalError, type RequestPrincipal } from "../request-principal.js";
import { SideChatBusyError, SideChatNotFoundError, type SideChatRepository } from "./side-chat-repository.js";

function failure(context: Context, error: unknown) {
  if (isRequestPrincipalError(error)) {
    const mapped = mapRequestPrincipalError(error, "Side chat request failed");
    if (mapped.log) console.error("[side-chat] Principal unavailable:", error.name);
    return context.json(mapped.body, mapped.status);
  }
  if (error instanceof SideChatNotFoundError) return context.json({ error: "Side chat not found." }, 404);
  if (error instanceof SideChatBusyError) return context.json({ error: "Side chat is busy. Try again." }, 409);
  if (error instanceof z.ZodError) return context.json({ error: "Invalid side chat request." }, 400);
  if (error instanceof Error && error.name === "BodyLimitError") return context.json({ error: "Side chat request is too large." }, 413);
  console.error("[side-chat] Request failed:", error instanceof Error ? error.name : "UnknownError");
  return context.json({ error: "Side chat is unavailable. Try again." }, 503);
}

export function createSideChatRoutes(options: {
  repository: SideChatRepository | null;
  getPrincipal(context: Context): RequestPrincipal;
  generate(prompt: string, signal: AbortSignal): Promise<{ text: string }>;
}): Hono {
  const routes = new Hono();
  const owner = (context: Context) => ({ type: "personal" as const, ownerId: options.getPrincipal(context).userId });
  const repository = () => { if (!options.repository) throw new Error("SideChatRepositoryUnavailable"); return options.repository; };
  routes.get("/api/chats/:chatId/side-chat", async context => {
    try {
      const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
      return context.json(CanonicalSideChatSnapshotSchema.parse(await repository().read(owner(context), chatId)));
    } catch (error: unknown) { return failure(context, error); }
  });
  routes.post("/api/chats/:chatId/side-chat", bodyLimit({ maxSize: 256 }), async context => {
    try {
      const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
      if (!z.object({}).strict().safeParse(await context.req.json()).success) throw new z.ZodError([]);
      return context.json(CanonicalSideChatSnapshotSchema.parse(await repository().create(owner(context), chatId)));
    } catch (error: unknown) { return failure(context, error); }
  });
  routes.post("/api/chats/:chatId/side-chat/turns", bodyLimit({ maxSize: 16 * 1024 }), async context => {
    try {
      const chatId = CanonicalChatIdSchema.parse(context.req.param("chatId"));
      const request = CanonicalSideChatTurnRequestSchema.parse(await context.req.json());
      return context.json(CanonicalSideChatSnapshotSchema.parse(await repository().ask(owner(context), chatId, request, options.generate)));
    } catch (error: unknown) { return failure(context, error); }
  });
  return routes;
}
