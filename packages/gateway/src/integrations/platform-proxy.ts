import type { Context } from "hono";
import { MATRIX_MCP_RUN_CONTEXT_KEY, type MatrixMcpRunContext } from "../chat/matrix-mcp-launch.js";
import { integrationProxyHeaders } from "./custom-mcp/proxy-headers.js";
import { delegatedIntegrationHeaders } from "./delegated-identity.js";
import { createIntegrationProxyResponse } from "./proxy-response.js";
import { INTEGRATION_READ_SCOPE_HEADER } from "./scope-provenance.js";
import { requireRequestPrincipal } from "../request-principal.js";

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
  },
): Promise<Response> {
  const routePrefix = options.routePrefix ?? "/api/integrations";
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
