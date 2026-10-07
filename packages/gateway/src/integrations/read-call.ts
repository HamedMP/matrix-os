import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { PlatformDb } from "../platform-db.js";
import { executeIntegrationAction } from "./action-execution.js";
import { integrationActionFailure, integrationActionSuccess } from "./call-outcome.js";
import { resolveIntegrationConnection } from "./connection-selection.js";
import { validateActionParams } from "./parameter-validation.js";
import type { PipedreamConnectClient } from "./pipedream.js";
import { getAction, getService } from "./registry.js";
import { executeJevBoundRead, JevBoundReadError, JevReadBindingSchema } from "./jev-bound-read.js";
import type { ServiceDefinition } from "./types.js";

const ReadCallBodySchema = z.strictObject({
  service: z.string().min(1).max(100),
  action: z.string().min(1).max(100),
  label: z.string().trim().min(1).max(100),
  params: z.record(z.string(), z.unknown()).optional(),
  binding: JevReadBindingSchema.optional(),
  connectionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/).optional(),
});

/** The dedicated scoped route never syncs, chooses an account, or calls a preset without exact selection. */
export function createIntegrationReadCallRoutes(options: {
  db: PlatformDb;
  pipedream: PipedreamConnectClient;
  resolveUserId: (c: Context) => Promise<string | null>;
  presetBroker?: {
    listConnections(userId: string): Promise<Array<{ id: string; service: string; account_label: string; status: string }>>;
    call(input: { userId: string; service: ServiceDefinition; actionId: string; params?: Record<string, unknown>; connectionId?: string }): Promise<unknown>;
  };
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
    const { service, action, label, params, binding, connectionId } = parsed.data;
    if (binding && (service !== "gmail" || label !== binding.accountLabel)) {
      return c.json({ error: "Action not permitted" }, 403);
    }
    const def = getService(service);
    const actionDef = getAction(service, action);
    if (!def || !actionDef) return c.json({ error: "Unknown integration action" }, 400);
    if (actionDef.risk !== "read") {
      return c.json({ error: "Action not permitted" }, 403);
    }
    if (!validateActionParams(actionDef, params).valid) {
      return c.json({ error: "Invalid action parameters" }, 400);
    }

    if (def.connectorKind === "mcp_preset" || def.connectorKind === "managed_oauth") {
      if (!options.presetBroker || binding) return c.json({ error: "Integration unavailable" }, 503);
      try {
        const selected = resolveIntegrationConnection(
          (await options.presetBroker.listConnections(uid)).filter(connection => connection.status === "active"), service, label,
        );
        if (selected.kind === "ambiguous") return c.json({ error: "Integration account label is ambiguous" }, 409);
        if (selected.kind === "missing") return c.json({ error: "Integration account unavailable" }, 400);
        if (connectionId && selected.connection.id !== connectionId) return c.json({ error: "Action not permitted" }, 403);
        const data = await options.presetBroker.call({ userId: uid, service: def, actionId: action, params, connectionId: selected.connection.id });
        return c.json({ data, service, action });
      } catch (err: unknown) { return integrationActionFailure(c, err, service, action); }
    }

    const selected = resolveIntegrationConnection(await options.db.listConnectedServices(uid), service, label);
    if (selected.kind === "ambiguous") return c.json({ error: "Integration account label is ambiguous" }, 409);
    if (selected.kind === "missing") return c.json({ error: "Integration account unavailable" }, 400);
    if (connectionId && selected.connection.id !== connectionId) return c.json({ error: "Action not permitted" }, 403);
    const user = await options.db.getUserById(uid);
    if (!user?.pipedream_external_id) return c.json({ error: "Integration unavailable" }, 503);
    try {
      if (binding) {
        const data = await executeJevBoundRead({ ownerId: uid, externalUserId: user.pipedream_external_id,
          connection: selected.connection, binding, action, params, pipedream: options.pipedream, signal: c.req.raw.signal });
        return integrationActionSuccess(c, { db: options.db, connectionId: selected.connection.id, service, action, data });
      }
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
      return integrationActionSuccess(c, {
        db: options.db,
        connectionId: selected.connection.id,
        service,
        action,
        data,
        summary,
      });
    } catch (err: unknown) {
      if (err instanceof JevBoundReadError) return c.json({ error: "Integration read unavailable" }, err.code === "denied" ? 403 : 503);
      return integrationActionFailure(c, err, service, action);
    }
  });
  return app;
}
