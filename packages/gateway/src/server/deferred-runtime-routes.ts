/** Mount integration/app runtime routes and metrics after gateway auth. */
import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { installPostHogHonoErrorTracking } from "@matrix-os/observability";
import { registerCustomMcpGatewayRoutes } from "../integrations/custom-mcp/gateway-routes.js";
import { resolveCustomMcpRuntimeRouting } from "../integrations/custom-mcp/preview-routing.js";
import { httpRequestDuration, httpRequestsTotal, metricsRegistry, normalizePath } from "../metrics.js";
import { registerAppRuntimeRoutes } from "./app-runtime-routes.js";

const INTEGRATION_PROXY_BODY_LIMIT = 64 * 1024;

export interface DeferredRuntimeRouteOptions {
  app: Hono;
  homePath: string;
  integrationRoutes: Hono | null;
  internalIntegrationBaseUrl: string | null;
  internalPlatformToken: string | undefined;
  internalPlatformUrl: string | undefined;
  internalHandle: string | undefined;
  proxyIntegrationRequest(c: Context, targetBase: string, internalAuthToken?: string, routePrefix?: string): Promise<Response>;
  devAppAuthBypass: boolean;
  posthogErrorTracker: ReturnType<typeof installPostHogHonoErrorTracking>;
  ownerTelemetryDistinctId: string;
}

export function registerDeferredRuntimeRoutes(options: DeferredRuntimeRouteOptions): ReturnType<typeof registerAppRuntimeRoutes> {
  const { app, homePath, integrationRoutes, internalIntegrationBaseUrl,
    internalPlatformToken, internalPlatformUrl, internalHandle,
    proxyIntegrationRequest, posthogErrorTracker, ownerTelemetryDistinctId } = options;
  const APP_AUTH_DEV_BYPASS = options.devAppAuthBypass;
  // HKDF master secret for per-app session cookies. In production MATRIX_AUTH_TOKEN
  // is the source. When it is absent (local dev, .env.example default) we mint an
  // ephemeral process-scoped secret so the HKDF input is never predictable — an
  // empty master secret combined with the public info string would otherwise let
  // anyone forge matrix_app_session cookies for any installed slug. The trade-off
  // is that app-session cookies do not survive a gateway restart in dev mode.
  const envMasterSecret = process.env.MATRIX_AUTH_TOKEN;
  const appSessionMasterSecret = envMasterSecret && envMasterSecret.length >= 16
    ? envMasterSecret
    : (() => {
        const reason = !envMasterSecret
          ? "MATRIX_AUTH_TOKEN not set"
          : "MATRIX_AUTH_TOKEN too short (<16 bytes)";
        console.warn(
          `[gateway] ${reason}; using ephemeral app-session master secret (app-session cookies will not survive gateway restart).`,
        );
        return randomBytes(32).toString("hex");
      })();

  // Deferred route mounts -- must come AFTER auth middleware
  if (integrationRoutes) {
    app.route("/api/integrations", integrationRoutes);
    console.log("[platform-db] Integration routes mounted (after auth)");
  } else if (internalIntegrationBaseUrl && internalPlatformToken && internalPlatformUrl) {
    app.all("/api/integrations", bodyLimit({ maxSize: INTEGRATION_PROXY_BODY_LIMIT }), async (c) =>
      proxyIntegrationRequest(c, internalIntegrationBaseUrl, internalPlatformToken),
    );
    app.all("/api/integrations/*", bodyLimit({ maxSize: INTEGRATION_PROXY_BODY_LIMIT }), async (c) => {
      const isPublic =
        c.req.path === "/api/integrations/available" ||
        c.req.path.startsWith("/api/integrations/webhook/");
      const targetBase = isPublic
        ? `${internalPlatformUrl}/api/integrations`
        : internalIntegrationBaseUrl;
      return proxyIntegrationRequest(c, targetBase, isPublic ? undefined : internalPlatformToken);
    });
    console.log("[platform-db] Integration routes proxied via platform internal API");
  }
  const customMcpRouting = resolveCustomMcpRuntimeRouting(process.env, {
    internalPlatformUrl,
    internalPlatformToken,
    clerkUserId: process.env.MATRIX_CLERK_USER_ID ?? process.env.MATRIX_USER_ID,
    projectionToken: process.env.UPGRADE_TOKEN,
  });
  registerCustomMcpGatewayRoutes(app, {
    homePath,
    clerkUserId: customMcpRouting.clerkUserId,
    projectionToken: customMcpRouting.projectionToken,
    ...(customMcpRouting.internalPlatformUrl && internalHandle && customMcpRouting.internalPlatformToken
      ? {
          platformProxy: {
            internalPlatformUrl: customMcpRouting.internalPlatformUrl,
            handle: internalHandle,
            token: customMcpRouting.internalPlatformToken,
            request: (
              context: Context,
              targetBase: string,
              routePrefix: "/api/mcp-servers",
              token: string,
            ) => proxyIntegrationRequest(context, targetBase, token, routePrefix),
          },
        }
      : {}),
  });

  const processManager = registerAppRuntimeRoutes(app, {
    homePath,
    appSessionMasterSecret,
    devAppAuthBypass: APP_AUTH_DEV_BYPASS,
    publicHost: process.env.PUBLIC_HOST ?? "localhost",
    onAppError: ({ errorKind, appSlug }) => {
      void posthogErrorTracker.captureEvent("gateway_app_runtime", {
        distinctId: ownerTelemetryDistinctId,
        properties: {
          source: "gateway-app-runtime",
          event: "app_error",
          error_kind: errorKind,
          app_slug: appSlug,
        },
      });
    },
  });

  app.use("*", async (c, next) => {
    const start = performance.now();
    await next();
    const duration = (performance.now() - start) / 1000;
    const path = normalizePath(c.req.path);
    const method = c.req.method;
    const status = String(c.res.status);
    httpRequestsTotal.inc({ method, path, status });
    httpRequestDuration.observe({ method, path }, duration);
  });

  app.get("/metrics", async (c) => {
    const output = await metricsRegistry.metrics();
    return c.text(output, 200, {
      "Content-Type": metricsRegistry.contentType,
    });
  });

  return processManager;
}
