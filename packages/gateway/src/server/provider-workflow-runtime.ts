import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createProviderWorkflowRoutes } from "../ai-providers/provider-workflow-routes.js";
import { createProviderWorkflowService, type ProviderWorkflowAdapter } from "../ai-providers/provider-workflows.js";

/** Keep workflow registration and teardown out of the gateway composition entrypoint. */
export async function registerProviderWorkflowRuntime(options: {
  app: Hono;
  ownerId: string | null;
  getPrincipal: (context: Context) => { userId: string } | null;
  createAdapters: () => Promise<readonly ProviderWorkflowAdapter[]>;
}): Promise<{ close(): Promise<void> }> {
  if (options.ownerId === null) {
    const unavailable = new Hono();
    unavailable.use("*", async (c, next) => { c.header("Cache-Control", "private, no-store"); await next(); });
    unavailable.use("*", bodyLimit({ maxSize: 8192 }));
    unavailable.all("*", c => {
      if (!options.getPrincipal(c)) return c.json({ error: { code: "unauthorized", message: "Authentication is required." } }, 401);
      return c.json({ error: { code: "unavailable", message: "This operation is unavailable. Refresh and try again." } }, 503);
    });
    options.app.route("/api/ai/provider-settings/workflows", unavailable);
    return { close: async () => {} };
  }
  const service = createProviderWorkflowService({ ownerId: options.ownerId, adapters: options.createAdapters });
  options.app.route("/api/ai", createProviderWorkflowRoutes({ service, getPrincipal: options.getPrincipal }));
  return { close: () => service.close() };
}
