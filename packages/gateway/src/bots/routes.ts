/**
 * Bots HTTP routes (spec 536, contracts/bots-http-api.md). Every route
 * authenticates the request principal; a bot never stands in for a person.
 * Bodies are bounded and strictly validated, errors come from one mapper
 * with allowlisted codes and generic messages, and responses are private.
 */
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { isRequestPrincipalError, mapRequestPrincipalError, type RequestPrincipal } from "../request-principal.js";
import { BotInstantiationError, type BotInstantiation } from "./instantiation.js";

const MAX_BODY_BYTES = 64 * 1024;

type ErrorCode = "invalid_request" | "conflict" | "rate_limited" | "unavailable";
const ERRORS: Record<ErrorCode, { status: 400 | 409 | 429 | 503; message: string }> = {
  invalid_request: { status: 400, message: "The request is invalid." },
  conflict: { status: 409, message: "This request was already used for a different bot." },
  rate_limited: { status: 429, message: "You have reached the bot limit." },
  unavailable: { status: 503, message: "Bots are temporarily unavailable." },
};

function errorResponse(context: Context, code: ErrorCode) {
  context.header("Cache-Control", "private, no-store");
  return context.json({ code, message: ERRORS[code].message }, ERRORS[code].status);
}

export function createBotRoutes(options: {
  instantiation?: Pick<BotInstantiation, "instantiate">;
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
    if (error instanceof BotInstantiationError) return errorResponse(context, error.code);
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

  return routes;
}
