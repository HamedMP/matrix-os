/**
 * Bots HTTP routes (spec 536, contracts/bots-http-api.md). Every route
 * authenticates the request principal; a bot never stands in for a person.
 * Bodies are bounded and strictly validated, errors come from one mapper
 * with allowlisted codes and generic messages, and responses are private.
 */
import { BotGrantIdSchema, BotInteractionIdSchema, BotMemoryItemIdSchema, CanonicalChatIdSchema, ChatAgentIdSchema } from "@matrix-os/contracts";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isRequestPrincipalError, mapRequestPrincipalError, type RequestPrincipal } from "../request-principal.js";
import type { BotContinuationAdmitter } from "./continuations.js";
import { BotInstantiationError, type BotInstantiation } from "./instantiation.js";
import { BotInteractionError, type BotInteractionService } from "./interactions.js";
import { BotMemoryError, type BotMemoryService } from "./memory-service.js";
import { BotGrantError, type BotGrantService } from "./grants-service.js";
import { BotAuthorityError, type BotAuthority } from "./authority.js";

const MAX_BODY_BYTES = 64 * 1024;

type ErrorCode = "invalid_request" | "not_found" | "conflict" | "expired" | "rate_limited" | "unavailable";
const ERRORS: Record<ErrorCode, { status: 400 | 404 | 409 | 410 | 429 | 503; message: string }> = {
  invalid_request: { status: 400, message: "The request is invalid." },
  not_found: { status: 404, message: "Not found." },
  conflict: { status: 409, message: "This changed since you loaded it. Refresh and try again." },
  expired: { status: 410, message: "This request has expired." },
  rate_limited: { status: 429, message: "You have reached the bot limit." },
  unavailable: { status: 503, message: "Bots are temporarily unavailable." },
};

function errorResponse(context: Context, code: ErrorCode) {
  context.header("Cache-Control", "private, no-store");
  return context.json({ code, message: ERRORS[code].message }, ERRORS[code].status);
}

export function createBotRoutes(options: {
  instantiation?: Pick<BotInstantiation, "instantiate">;
  interactions?: Pick<BotInteractionService, "listPending" | "resolve">;
  memory?: Pick<BotMemoryService, "forget" | "confirm">;
  grants?: Pick<BotGrantService, "revoke">;
  authority?: Pick<BotAuthority, "view">;
  /** Admits the owner's answer as the next message; resolved at route registration. */
  admitContinuation?: BotContinuationAdmitter;
  getPrincipal(context: Context): RequestPrincipal;
}): Hono {
  const routes = new Hono();
  const limit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (context) => {
      context.header("Cache-Control", "private, no-store");
      return context.json({ code: "invalid_request", message: "The request is too large." }, 413);
    },
  });

  routes.onError((error: unknown, context) => {
    if (isRequestPrincipalError(error)) {
      const mapped = mapRequestPrincipalError(error);
      if (mapped.log) console.warn("[bots] principal context unavailable:", error.name);
      return context.json(mapped.body, mapped.status);
    }
    if (error instanceof SyntaxError) return errorResponse(context, "invalid_request");
    if (error instanceof BotInstantiationError || error instanceof BotInteractionError || error instanceof BotMemoryError
      || error instanceof BotGrantError || error instanceof BotAuthorityError) {
      return errorResponse(context, error.code);
    }
    console.warn("[bots] request failed:", error instanceof Error ? error.name : "UnknownError");
    return errorResponse(context, "unavailable");
  });

  routes.post("/api/chat-agents/instantiate", limit, async (context) => {
    const principal = options.getPrincipal(context);
    if (!options.instantiation) return errorResponse(context, "unavailable");
    const result = await options.instantiation.instantiate(principal.userId, await context.req.json());
    context.header("Cache-Control", "private, no-store");
    return context.json(result, result.operation === "created" ? 201 : 200);
  });

  routes.get("/api/chats/:chatId/interactions", async (context) => {
    const principal = options.getPrincipal(context);
    if (!options.interactions) return errorResponse(context, "unavailable");
    const chatId = CanonicalChatIdSchema.safeParse(context.req.param("chatId"));
    if (!chatId.success) return errorResponse(context, "invalid_request");
    const interactions = await options.interactions.listPending(principal.userId, chatId.data);
    context.header("Cache-Control", "private, no-store");
    return context.json({ interactions });
  });

  routes.post("/api/chats/:chatId/interactions/:interactionId/resolve", limit, async (context) => {
    const principal = options.getPrincipal(context);
    if (!options.interactions || !options.admitContinuation) return errorResponse(context, "unavailable");
    const chatId = CanonicalChatIdSchema.safeParse(context.req.param("chatId"));
    const interactionId = BotInteractionIdSchema.safeParse(context.req.param("interactionId"));
    if (!chatId.success || !interactionId.success) return errorResponse(context, "invalid_request");
    const { response, continuation } = await options.interactions.resolve(
      principal.userId, chatId.data, interactionId.data, await context.req.json(),
    );
    if (continuation) {
      // The answer is recorded either way; repeating this request retries the continuation.
      try {
        await options.admitContinuation(principal, continuation);
      } catch (error: unknown) {
        console.warn("[bots] answer continuation failed:", error instanceof Error ? error.name : "UnknownError");
        return errorResponse(context, "unavailable");
      }
    }
    context.header("Cache-Control", "private, no-store");
    return context.json(response);
  });

  for (const action of ["forget", "confirm"] as const) {
    routes.post(`/api/chat-agents/:agentId/memory/:itemId/${action}`, limit, async (context) => {
      const principal = options.getPrincipal(context);
      if (!options.memory) return errorResponse(context, "unavailable");
      const agentId = ChatAgentIdSchema.safeParse(context.req.param("agentId"));
      const itemId = BotMemoryItemIdSchema.safeParse(context.req.param("itemId"));
      if (!agentId.success || !itemId.success) return errorResponse(context, "invalid_request");
      const result = await options.memory[action](
        principal.userId, agentId.data, itemId.data, await context.req.json(),
      );
      context.header("Cache-Control", "private, no-store");
      return context.json(result);
    });
  }

  routes.get("/api/chat-agents/:agentId/authority", async (context) => {
    const principal = options.getPrincipal(context);
    if (!options.authority) return errorResponse(context, "unavailable");
    const view = await options.authority.view(principal.userId, context.req.param("agentId"));
    context.header("Cache-Control", "private, no-store");
    return context.json(view);
  });

  // DELETE is a mutation: bounded like the others, although it ignores any body.
  routes.delete("/api/chat-agents/:agentId/grants/:grantId", limit, async (context) => {
    const principal = options.getPrincipal(context);
    if (!options.grants) return errorResponse(context, "unavailable");
    const agentId = ChatAgentIdSchema.safeParse(context.req.param("agentId"));
    const grantId = BotGrantIdSchema.safeParse(context.req.param("grantId"));
    if (!agentId.success || !grantId.success) return errorResponse(context, "invalid_request");
    const result = await options.grants.revoke(principal.userId, agentId.data, grantId.data);
    context.header("Cache-Control", "private, no-store");
    return context.json(result);
  });

  return routes;
}
