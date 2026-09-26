import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MATRIX_MCP_RUN_CONTEXT_KEY } from "../../chat/matrix-mcp-launch.js";
import { createCustomMcpProjectionRoutes } from "./projection-routes.js";

const CUSTOM_MCP_PROXY_BODY_LIMIT = 64 * 1024;

async function proxyCustomMcpRequest(
  context: Context,
  proxy: CustomMcpPlatformProxyOptions,
  targetBase: string,
): Promise<Response> {
  // The Platform broker accepts approvalGranted=true from its trusted human
  // workflow. A Claude Run bearer proves actor identity, not human approval.
  // This provenance is set by authMiddleware, never from caller headers.
  if (context.get(MATRIX_MCP_RUN_CONTEXT_KEY as never) && context.req.method === "POST") {
    let body: unknown;
    try {
      body = await context.req.raw.clone().json();
    } catch (error: unknown) {
      if (error instanceof Error && error.name === "BodyLimitError") throw error;
      console.warn("[custom-mcp] scoped call body parse failed:", error instanceof Error ? error.name : typeof error);
      return context.json({ error: "Invalid request body" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return context.json({ error: "Invalid request body" }, 400);
    }
    if ((body as Record<string, unknown>).approvalGranted !== false) {
      return context.json({ error: "Tool approval is unavailable for this Run" }, 403);
    }
  }
  return proxy.request(context, targetBase, "/api/mcp-servers", proxy.token);
}

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
    (context) => proxyCustomMcpRequest(context, proxy, targetBase),
  );
  app.all(
    "/api/mcp-servers/*",
    bodyLimit({ maxSize: CUSTOM_MCP_PROXY_BODY_LIMIT }),
    (context) => proxyCustomMcpRequest(context, proxy, targetBase),
  );
}
