import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { PlatformDb } from "../platform-db.js";
import { executeIntegrationAction } from "./action-execution.js";
import { resolveIntegrationConnection } from "./connection-selection.js";
import { validateActionParams } from "./parameter-validation.js";
import type { PipedreamConnectClient } from "./pipedream.js";
import { getAction, getService } from "./registry.js";

const ReadCallBodySchema = z.strictObject({
  service: z.string().min(1).max(100),
  action: z.string().min(1).max(100),
  label: z.string().trim().min(1).max(100),
  params: z.record(z.string(), z.unknown()).optional(),
});

/** The dedicated scoped route never syncs, chooses an account, or calls a preset without exact selection. */
export function createIntegrationReadCallRoutes(options: {
  db: PlatformDb;
  pipedream: PipedreamConnectClient;
  resolveUserId: (c: Context) => Promise<string | null>;
}): Hono {
  const app = new Hono();
  app.post("/read-call", bodyLimit({ maxSize: 65536 }), async (c) => {
    const uid = await options.resolveUserId(c);
    if (!uid) return c.json({ error: "Unauthorized" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "BodyLimitError") {
        return c.json({ error: "Request too large" }, 413);
      }
      if (!(err instanceof SyntaxError)) console.warn("[integrations] Invalid read-call body:", err);
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const parsed = ReadCallBodySchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "Invalid request body" }, 400);
    const { service, action, label, params } = parsed.data;
    const def = getService(service);
    const actionDef = getAction(service, action);
    if (!def || !actionDef) return c.json({ error: "Unknown integration action" }, 400);
    if (actionDef.risk !== "read" || def.connectorKind !== "pipedream") {
      return c.json({ error: "Action not permitted" }, 403);
    }
    if (!validateActionParams(actionDef, params).valid) {
      return c.json({ error: "Invalid action parameters" }, 400);
    }

    const selected = resolveIntegrationConnection(await options.db.listConnectedServices(uid), service, label);
    if (selected.kind === "ambiguous") return c.json({ error: "Integration account label is ambiguous" }, 409);
    if (selected.kind === "missing") return c.json({ error: "Integration account unavailable" }, 400);
    const user = await options.db.getUserById(uid);
    if (!user?.pipedream_external_id) return c.json({ error: "Integration unavailable" }, 503);
    try {
      const { data, summary } = await executeIntegrationAction({
        pipedream: options.pipedream,
        externalUserId: user.pipedream_external_id,
        connection: selected.connection,
        def,
        actionDef,
        serviceId: service,
        actionId: action,
        params,
      });
      return c.json({ data, service, action, ...(summary ? { summary } : {}) });
    } catch (err: unknown) {
      console.error("[integrations] Scoped read call failed:", err);
      return c.json({ error: "Integration call failed" }, 502);
    }
  });
  return app;
}
