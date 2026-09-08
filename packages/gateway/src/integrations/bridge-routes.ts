import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { PlatformDb } from "../platform-db.js";
import type { PipedreamConnectClient } from "./pipedream.js";
import { formatActionParamValidationError, validateActionParams } from "./parameter-validation.js";
import { getAction, getService } from "./registry.js";
import {
  executeIntegrationAction,
  getErrorStatusCode,
  getRetryAfterSeconds,
  IntegrationActionNotImplementedError,
} from "./routes.js";

const BridgeCallBodySchema = z.object({
  service: z.string().min(1),
  action: z.string().min(1),
  label: z.string().trim().min(1).max(100).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

interface IntegrationBridgeRoutesOptions {
  platformDb: PlatformDb | null;
  pipedream: PipedreamConnectClient | null;
  resolveUserId: ((context: Context) => Promise<string | null>) | null;
}

export function createIntegrationBridgeRoutes(options: IntegrationBridgeRoutesOptions): Hono {
  const app = new Hono();

  app.get("/", async (context) => {
    if (!options.platformDb || !options.resolveUserId) {
      return context.json({ error: "Integrations not configured" }, 503);
    }
    const userId = await options.resolveUserId(context);
    if (!userId) return context.json({ error: "Unauthorized" }, 401);
    const services = await options.platformDb.listConnectedServices(userId);
    return context.json({
      services: services.map((service) => ({
        service: service.service,
        account_label: service.account_label,
        account_email: service.account_email,
        status: service.status,
      })),
    });
  });

  app.post("/", bodyLimit({ maxSize: 65_536 }), async (context) => {
    if (process.env.NODE_ENV === "production") {
      return context.json({ error: "Bridge not available in production" }, 403);
    }
    if (!options.platformDb || !options.pipedream || !options.resolveUserId) {
      return context.json({ error: "Integrations not configured" }, 503);
    }

    let requestBody: unknown;
    try {
      requestBody = await context.req.json();
    } catch (error: unknown) {
      if (error instanceof SyntaxError) {
        return context.json({ error: "Invalid JSON" }, 400);
      }
      console.error("[bridge/service] Failed to read request body:", error);
      return context.json({ error: "Failed to read request body" }, 500);
    }
    const parsed = BridgeCallBodySchema.safeParse(requestBody);
    if (!parsed.success) {
      return context.json({ error: "Invalid request body" }, 400);
    }

    const { service, action, label, params } = parsed.data;
    const definition = getService(service);
    if (!definition) return context.json({ error: `Unknown service: ${service}` }, 400);
    const actionDefinition = getAction(service, action);
    if (!actionDefinition) return context.json({ error: `Unknown action: ${action}` }, 400);

    const validation = validateActionParams(actionDefinition, params);
    if (!validation.valid) {
      return context.json({ error: formatActionParamValidationError(validation) }, 400);
    }

    const userId = await options.resolveUserId(context);
    if (!userId) return context.json({ error: "Unauthorized" }, 401);

    const connections = await options.platformDb.listConnectedServices(userId);
    const connection = label
      ? connections.find((item) => item.service === service && item.account_label === label)
      : connections.find((item) => item.service === service);
    if (!connection) {
      return context.json({ error: `Service ${service} is not connected` }, 404);
    }

    const fullUser = await options.platformDb.getUserById(userId);
    const externalId = fullUser?.pipedream_external_id || userId;
    if (!fullUser?.pipedream_external_id) {
      await options.platformDb.updatePipedreamExternalId(userId, externalId);
    }

    try {
      const { data, summary } = await executeIntegrationAction({
        pipedream: options.pipedream,
        externalUserId: externalId,
        connection,
        def: definition,
        actionDef: actionDefinition,
        serviceId: service,
        actionId: action,
        params,
      });
      await options.platformDb.touchServiceUsage(connection.id);
      return context.json({ data, service, action, ...(summary ? { summary } : {}) });
    } catch (error: unknown) {
      if (error instanceof IntegrationActionNotImplementedError) {
        return context.json({ error: "Integration action is unavailable" }, 501);
      }
      if (getErrorStatusCode(error) === 429) {
        const retryAfter = getRetryAfterSeconds(error);
        return context.json(
          { error: "Rate limited by provider. Please try again later.", retry_after: retryAfter },
          { status: 429, headers: { "Retry-After": String(retryAfter) } },
        );
      }
      const isAbort = error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError");
      if (isAbort) {
        console.error(`[bridge/service] ${service}/${action} timeout`);
        return context.json({ error: "Integration call timed out" }, 504);
      }
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("econnrefused") || message.includes("enotfound") || message.includes("enetunreach")) {
        console.error(`[bridge/service] ${service}/${action} connection error:`, error);
        return context.json({ error: "Integration service unavailable" }, 503);
      }
      console.error(`[bridge/service] ${service}/${action} error:`, error instanceof Error ? error.message : error);
      return context.json({ error: "Integration call failed" }, 502);
    }
  });

  return app;
}
