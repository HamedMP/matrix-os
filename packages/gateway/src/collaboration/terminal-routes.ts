/** Extracted verbatim from packages/gateway/src/collaboration/routes.ts (S01 / T008). */
import {
  CollaborationIdSchema,
  CollaborationTerminalActionSchema,
} from "@matrix-os/contracts";
import type { Hono } from "hono";
import {
  authorize,
  requireTerminalDispatcher,
  readJson,
  handle,
  type CollaborationRouteOptions,
} from "./route-support.js";

export function registerTerminalRoutes(routes: Hono, options: CollaborationRouteOptions): void {
  routes.get("/api/collaboration/scopes/:scopeId/terminal", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const context = await authorize(options, c, new Uint8Array(), "read", scopeId);
    return c.json(await requireTerminalDispatcher(options.terminalDispatcher).read(context));
  }));

  routes.post("/api/collaboration/scopes/:scopeId/terminal/actions", async (c) => handle(c, async () => {
    const scopeId = CollaborationIdSchema.parse(c.req.param("scopeId"));
    const { value, bytes } = await readJson(c);
    const action = CollaborationTerminalActionSchema.parse(value);
    const context = await authorize(options, c, bytes, "control_execution", scopeId);
    const connectionId = "connectionId" in action ? action.connectionId : `http_${context.actorId}`;
    return c.json(await requireTerminalDispatcher(options.terminalDispatcher).dispatch({
      scopeId,
      actorId: context.actorId,
      connectionId,
      action,
    }));
  }));
}
