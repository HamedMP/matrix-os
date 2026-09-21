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
  routes.on(["POST", "PATCH", "DELETE"], "/api/collaboration/*", mutationLimit);

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
