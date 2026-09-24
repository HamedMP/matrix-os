import { JevEvaluateRequestSchema, type JevEmailTriageResult } from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { JevServiceError, type JevService } from "./service.js";

const BODY_LIMIT_BYTES = 40 * 1024;

function safeError(code: JevServiceError["code"]): { error: { code: string; message: string } } {
  if (code === "conflict") return { error: { code, message: "This Jev request key was already used" } };
  if (code === "denied") return { error: { code, message: "Jev access is unavailable for this account" } };
  if (code === "in_progress") return { error: { code, message: "This Jev request is already in progress" } };
  if (code === "unknown") return { error: { code, message: "The Jev request outcome is unknown" } };
  return { error: { code: "unavailable", message: "Jev is temporarily unavailable" } };
}

export function createJevRoutes(options: {
  service: Pick<JevService, "evaluate"> | null;
  resolveOwnerId: (context: Context) => string | null | Promise<string | null>;
}): Hono {
  const app = new Hono();
  app.post("/evaluate", bodyLimit({
    maxSize: BODY_LIMIT_BYTES,
    onError: (c) => c.json({ error: { code: "invalid_request", message: "Jev request is too large" } }, 413),
  }), async (c) => {
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
      return c.json({ error: { code: "invalid_request", message: "Content-Type must be application/json" } }, 415);
    }
    let value: unknown;
    try {
      value = await c.req.json();
    } catch (error) {
      if (error instanceof Error && error.name === "BodyLimitError") {
        return c.json({ error: { code: "invalid_request", message: "Jev request is too large" } }, 413);
      }
      if (!(error instanceof SyntaxError)) {
        console.warn("[jev] Request body read failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
      }
      return c.json({ error: { code: "invalid_request", message: "Invalid Jev request" } }, 400);
    }
    const input = JevEvaluateRequestSchema.safeParse(value);
    if (!input.success) return c.json({ error: { code: "invalid_request", message: "Invalid Jev request" } }, 400);
    if (!options.service) return c.json(safeError("unavailable"), 503);
    try {
      const ownerId = await options.resolveOwnerId(c);
      if (!ownerId) return c.json({ error: { code: "unauthorized", message: "Unauthorized" } }, 401);
      const result: JevEmailTriageResult = await options.service.evaluate(ownerId, input.data, c.req.raw.signal);
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof JevServiceError) {
        const status = error.code === "conflict" ? 409
          : error.code === "denied" ? 403
          : error.code === "in_progress" ? 409
          : 503;
        return c.json(safeError(error.code), status);
      }
      console.warn("[jev] Evaluation failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
      return c.json(safeError("unavailable"), 503);
    }
  });
  return app;
}
