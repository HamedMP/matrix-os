import type { Hono } from "hono";
import { createCustomMcpProjectionRoutes } from "./projection-routes.js";

export interface CustomMcpGatewayRouteOptions {
  homePath: string;
  clerkUserId?: string;
  projectionToken?: string;
}

export function registerCustomMcpGatewayRoutes(
  app: Hono,
  options: CustomMcpGatewayRouteOptions,
): void {
  if (!options.clerkUserId || !options.projectionToken) return;
  app.route(
    "/api/internal/mcp-projection",
    createCustomMcpProjectionRoutes({
      homePath: options.homePath,
      token: options.projectionToken,
      clerkUserId: options.clerkUserId,
    }),
  );
}
