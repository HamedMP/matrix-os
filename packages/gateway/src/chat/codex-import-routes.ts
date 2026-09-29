import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ZodError } from "zod/v4";
import { isRequestPrincipalError, mapRequestPrincipalError, type RequestPrincipal } from "../request-principal.js";
import { CodexChatImporter, CodexChatImportError } from "./codex-importer.js";

function fail(context: Context, error: unknown): Response {
  if (isRequestPrincipalError(error)) {
    const mapped = mapRequestPrincipalError(error, "Chat import unavailable");
    if (mapped.log) console.error("[chat/import] principal unavailable", error.name);
    return context.json(mapped.body, mapped.status);
  }
  if (error instanceof CodexChatImportError) {
    const status = error.code === "not_found" ? 404
      : error.code === "too_large" ? 413 : 409;
    return context.json({ error: "Chat import failed", code: error.code }, status);
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return context.json({ error: "Invalid Chat import request", code: "invalid_request" }, 400);
  }
  console.warn("[chat/import] unavailable", error instanceof Error ? error.name : "UnknownError");
  return context.json({ error: "Chat import unavailable", code: "unavailable" }, 503);
}

export function createCodexChatImportRoutes(options: {
  importer: CodexChatImporter | null;
  getPrincipal(context: Context): RequestPrincipal;
}): Hono {
  const routes = new Hono();
  const smallBody = bodyLimit({ maxSize: 4 * 1024,
    onError: (context) => context.json({ error: "Chat import request too large", code: "too_large" }, 413) });
  const batchBody = bodyLimit({ maxSize: 512 * 1024,
    onError: (context) => context.json({ error: "Chat import batch too large", code: "too_large" }, 413) });
  const owner = (context: Context) => ({ type: "personal" as const,
    ownerId: options.getPrincipal(context).userId });
  const importer = () => {
    if (!options.importer) throw new Error("Chat import backend unavailable");
    return options.importer;
  };

  routes.post("/api/chats/imports/codex", smallBody, async (context) => {
    try {
      const result = await importer().begin(owner(context), await context.req.json());
      return context.json(result, 201);
    } catch (error: unknown) { return fail(context, error); }
  });
  routes.post("/api/chats/imports/codex/:sourceId/messages", batchBody, async (context) => {
    try {
      const result = await importer().append(owner(context), context.req.param("sourceId"), await context.req.json());
      return context.json(result);
    } catch (error: unknown) { return fail(context, error); }
  });
  routes.post("/api/chats/imports/codex/:sourceId/complete", smallBody, async (context) => {
    try {
      const result = await importer().complete(owner(context), context.req.param("sourceId"), await context.req.json());
      return context.json(result);
    } catch (error: unknown) { return fail(context, error); }
  });
  return routes;
}
