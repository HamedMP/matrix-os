import { COLLABORATION_HTTP_BODY_LIMIT } from "@matrix-os/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { registerChatRoutes } from "./chat-routes.js";
import { registerCapabilityRoutes } from "./capability-routes.js";
import { registerOwnerCatalogRoutes } from "./owner-catalog-routes.js";
import { registerExecutionPolicyRoutes } from "./execution-policy-routes.js";
import { registerLifecycleRoutes } from "./lifecycle-routes.js";
import { registerProjectRoutes } from "./project-routes.js";
import { registerResourceRoutes } from "./resource-routes.js";
import type { CollaborationRouteOptions } from "./route-support.js";
import { registerScopeRoutes } from "./scope-routes.js";
import { registerTerminalRoutes } from "./terminal-routes.js";

export type { CollaborationRouteOptions, Participant } from "./route-support.js";

/** Only a canonical scope identifier selects the per-scope gate; anything else stays runtime-wide. */
const SCOPE_MUTATION_PATH = /^\/api\/collaboration\/scopes\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

/**
 * Composition entrypoint for the owner-home collaboration HTTP routes. The
 * per-resource modules register handlers in the original routes.ts order;
 * route-support.ts owns the shared authorization, projection and error mapping.
 */
export function createCollaborationRoutes(options: CollaborationRouteOptions): Hono {
  const routes = new Hono();
  const mutationLimit = bodyLimit({
    maxSize: COLLABORATION_HTTP_BODY_LIMIT,
    onError: (c) => c.json({ error: "Collaboration request too large", code: "invalid_request" }, 413),
  });
  routes.use("/api/collaboration/*", async (c, next) => {
    c.header("Cache-Control", "private, no-store");
    await next();
  });
  routes.on(["POST", "PUT", "PATCH", "DELETE"], "/api/collaboration/*", mutationLimit);
  routes.on(["POST", "PUT", "PATCH", "DELETE"], "/api/collaboration/*", async (c, next) => {
    const guard = options.cutoverGuard;
    if (guard) {
      // A scope-identified mutation is admitted by that scope's own cutover journal, so one
      // recovering scope cannot fence collaboration writes for every other scope of this home.
      // Paths that carry no scope keep the runtime-wide gate.
      const scopeId = SCOPE_MUTATION_PATH.exec(c.req.path)?.[1];
      try {
        if (scopeId) await guard.assertWritable(scopeId);
        else await guard.assertRuntimeWritable(options.runtimeId);
      } catch (error: unknown) {
        // Do not expose inventory, database, or host failures at this pre-auth boundary.
        console.warn("[collaboration] cutover admission unavailable", error instanceof Error ? error.name : "UnknownError");
        return c.json({ error: "Collaboration is unavailable", code: "unavailable" }, 503);
      }
    }
    await next();
  });

  registerScopeRoutes(routes, options);
  registerCapabilityRoutes(routes, options);
  registerOwnerCatalogRoutes(routes, options);
  registerChatRoutes(routes, options);
  registerTerminalRoutes(routes, options);
  registerProjectRoutes(routes, options);
  registerLifecycleRoutes(routes, options);
  // S08: owner-selected execution policy (GET/PUT) registers after the baseline routes.
  registerExecutionPolicyRoutes(routes, options);
  // S12: files, folders and app instances (project-bound and standalone) after the baseline routes.
  registerResourceRoutes(routes, options);

  return routes;
}
