import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { ChatAgentIdSchema, BotRoutineIdSchema } from "@matrix-os/contracts";
import { BotRoutineControlSchema } from "@matrix-os/contracts";
import { BotStateError } from "./repositories/shared.js";
import type { BotRoutineExecution } from "./routine-execution.js";
import { isRequestPrincipalError, mapRequestPrincipalError, type RequestPrincipal } from "../request-principal.js";
const errors = {
  invalid_request: [400, "The request is invalid."],
  not_found: [404, "Not found."],
  conflict: [409, "This changed. Refresh and try again."],
  rate_limited: [429, "You have reached the routine limit."],
  unavailable: [503, "Routines are temporarily unavailable."]
} as const;
function error(c: Context, code: keyof typeof errors) {
  c.header("Cache-Control", "private, no-store");
  return c.json({
    code,
    message: errors[code][1]
  }, errors[code][0]);
}
export function createBotRoutineRoutes(deps: {
  routines?: Pick<BotRoutineExecution, "list" | "control">;
  getPrincipal(c: Context): RequestPrincipal;
}) {
  const app = new Hono(),
    limit = bodyLimit({
      maxSize: 64 * 1024,
      onError: c => {
        c.header("Cache-Control", "private, no-store");
        return c.json({
          code: "invalid_request",
          message: "The request is too large."
        }, 413);
      }
    });
  app.onError((e: unknown, c) => {
    if (isRequestPrincipalError(e)) {
      const mapped = mapRequestPrincipalError(e);
      return c.json(mapped.body, mapped.status);
    }
    if (e instanceof z.ZodError || e instanceof SyntaxError) return error(c, "invalid_request");
    if (e instanceof BotStateError) return error(c, e.code === "not_found" ? "not_found" : ["conflict", "revision_conflict", "invalid_transition"].includes(e.code) ? "conflict" : e.code === "capacity_exceeded" ? "rate_limited" : "invalid_request");
    console.warn("[bots] routine request unavailable", e instanceof Error ? e.name : "UnknownError");
    return error(c, "unavailable");
  });
  app.get("/api/chat-agents/:agentId/routines", async c => {
    const principal = deps.getPrincipal(c),
      agent = ChatAgentIdSchema.safeParse(c.req.param("agentId"));
    if (!agent.success) return error(c, "invalid_request");
    if (!deps.routines) return error(c, "unavailable");
    c.header("Cache-Control", "private, no-store");
    return c.json({
      routines: await deps.routines.list(principal.userId, agent.data)
    });
  });
  app.post("/api/chat-agents/:agentId/routines/:routineId/control", limit, async c => {
    const principal = deps.getPrincipal(c),
      agent = ChatAgentIdSchema.safeParse(c.req.param("agentId")),
      routine = BotRoutineIdSchema.safeParse(c.req.param("routineId"));
    if (!agent.success || !routine.success) return error(c, "invalid_request");
    const body = BotRoutineControlSchema.parse(await c.req.json());
    if (!deps.routines) return error(c, "unavailable");
    const result = await deps.routines.control(principal.userId, agent.data, routine.data, body);
    c.header("Cache-Control", "private, no-store");
    return c.json({
      routineId: result.routineId,
      status: result.status,
      revision: result.revision
    });
  });
  return app;
}
