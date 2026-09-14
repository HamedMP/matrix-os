import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { createCustomMcpProjectionRoutes } from "./projection-routes.js";

const CUSTOM_MCP_PROXY_BODY_LIMIT = 64 * 1024;

export interface CustomMcpPlatformProxyOptions {
  internalPlatformUrl: string;
  handle: string;
  token: string;
  request: (
    context: Context,
    targetBase: string,
    routePrefix: "/api/mcp-servers",
    token: string,
  ) => Promise<Response>;
}

export interface CustomMcpGatewayRouteOptions {
  homePath: string;
  clerkUserId?: string;
  projectionToken?: string;
  platformProxy?: CustomMcpPlatformProxyOptions;
}

export function registerCustomMcpGatewayRoutes(
  app: Hono,
  options: CustomMcpGatewayRouteOptions,
): void {
  if (options.clerkUserId && options.projectionToken) {
    app.route(
      "/api/internal/mcp-projection",
      createCustomMcpProjectionRoutes({
        homePath: options.homePath,
        token: options.projectionToken,
        clerkUserId: options.clerkUserId,
      }),
    );
  }

  const proxy = options.platformProxy;
  if (!proxy) return;
  const targetBase = `${proxy.internalPlatformUrl}/internal/containers/${encodeURIComponent(proxy.handle)}/mcp-servers`;
  app.all(
    "/api/mcp-servers",
    bodyLimit({ maxSize: CUSTOM_MCP_PROXY_BODY_LIMIT }),
    (context) => proxy.request(context, targetBase, "/api/mcp-servers", proxy.token),
  );
  app.all(
    "/api/mcp-servers/*",
    bodyLimit({ maxSize: CUSTOM_MCP_PROXY_BODY_LIMIT }),
    (context) => proxy.request(context, targetBase, "/api/mcp-servers", proxy.token),
  );
}
