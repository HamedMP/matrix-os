import type { Context } from "hono";
import { MATRIX_MCP_RUN_CONTEXT_KEY, type MatrixMcpRunContext } from "../chat/matrix-mcp-launch.js";
import { integrationProxyHeaders } from "./custom-mcp/proxy-headers.js";
import { delegatedIntegrationHeaders } from "./delegated-identity.js";
import { createIntegrationProxyResponse } from "./proxy-response.js";
import { INTEGRATION_READ_SCOPE_HEADER } from "./scope-provenance.js";
import { requireRequestPrincipal } from "../request-principal.js";
import { authorizeChatIntegrationRequest, MATRIX_PREVIEW_DRIVE_ACTION_GRANT_KEY } from "./chat-action-guard.js";
import type { PreviewDrivePlatformClient } from "../chat/preview-drive-platform-client.js";
import { previewDriveActionCanonical } from "@matrix-os/contracts";

function buildIntegrationProxyUrl(c: Context, targetBase: string, routePrefix: string): string {
  const targetUrl = new URL(targetBase);
  const suffix = c.req.path.replace(routePrefix, "") || "";
  const decodedSuffix = decodeURIComponent(suffix);
  if (decodedSuffix.split("/").some((segment) => segment === "..")) {
    throw new Error("Invalid integration proxy path");
  }
  const basePath = targetUrl.pathname.endsWith("/")
    ? targetUrl.pathname.slice(0, -1)
    : targetUrl.pathname;
  targetUrl.pathname = suffix ? `${basePath}${suffix}` : basePath;
  targetUrl.search = new URL(c.req.url).search;
  return targetUrl.toString();
}

/** Forward an authenticated Gateway request to Platform with server-derived headers. */
export async function proxyIntegrationRequest(
  c: Context,
  options: {
    targetBase: string;
    machineToken?: string;
    routePrefix?: string;
    fetcher?: typeof fetch;
    previewDriveClient?: Pick<PreviewDrivePlatformClient, "discover" | "execute">;
  },
): Promise<Response> {
  const routePrefix = options.routePrefix ?? "/api/integrations";
  if (routePrefix === "/api/integrations") {
    const denied = await authorizeChatIntegrationRequest(c);
    if (denied) return denied;
    const run = c.get(MATRIX_MCP_RUN_CONTEXT_KEY as never) as MatrixMcpRunContext | undefined;
    if (run?.scope === "preview_drive_call") {
      if (!run.previewDrive || !options.previewDriveClient || new URL(c.req.url).search) {
        return c.json({ error: "Integration unavailable" }, 403);
      }
      const scope = { runGrant: run.previewDrive.runGrant, chatId: run.previewDrive.chatId,
        runId: run.previewDrive.runId };
      try {
        if (c.req.method === "GET") {
          const kind = c.req.path === "/api/integrations" ? "inventory"
            : c.req.path === "/api/integrations/agent-catalog" ? "catalog" : null;
          if (!kind) return c.json({ error: "Integration unavailable" }, 403);
          return c.json(await options.previewDriveClient.discover({ ...scope, kind }), 200,
            { "cache-control": "no-store" });
        }
        if (c.req.method !== "POST" || c.req.path !== "/api/integrations/call") {
          return c.json({ error: "Integration unavailable" }, 403);
        }
        const actionGrant = c.get(MATRIX_PREVIEW_DRIVE_ACTION_GRANT_KEY as never) as string | undefined;
        const action = await c.req.raw.clone().json();
        if (!actionGrant || !previewDriveActionCanonical(action)) return c.json({ error: "Integration unavailable" }, 403);
        return c.json(await options.previewDriveClient.execute({ ...scope, actionGrant, action }), 200,
          { "cache-control": "no-store" });
      } catch (error: unknown) {
        console.warn("[integrations] Preview Drive request failed", error instanceof Error ? error.name : "UnknownError");
        return c.json({ error: "Integration unavailable" }, 503);
      }
    }
  }
  let upstreamUrl: string;
  try {
    upstreamUrl = buildIntegrationProxyUrl(c, options.targetBase, routePrefix);
  } catch (err: unknown) {
    console.warn("[integrations] rejected proxy path:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "Bad request" }, 400);
  }
  const headers = integrationProxyHeaders(c, routePrefix);
  if (options.machineToken) {
    headers.set("authorization", `Bearer ${options.machineToken}`);
    if (routePrefix === "/api/integrations") {
      // Platform verifies this machine's token, so sign the authenticated
      // Gateway principal rather than forwarding any caller-supplied ID.
      const actorId = requireRequestPrincipal(c).userId;
      for (const [key, value] of Object.entries(delegatedIntegrationHeaders(actorId, options.machineToken))) {
        headers.set(key, value);
      }
      const runContext = c.get(MATRIX_MCP_RUN_CONTEXT_KEY as never) as MatrixMcpRunContext | undefined;
      if (runContext?.scope === "integration_read") {
        headers.set(INTEGRATION_READ_SCOPE_HEADER, "read");
      }
    }
  }
  const upstream = await (options.fetcher ?? fetch)(upstreamUrl, {
    method: c.req.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    body: ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.blob(),
  });
  return createIntegrationProxyResponse(upstream);
}
