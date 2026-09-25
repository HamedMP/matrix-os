import type { Context } from "hono";
import { MATRIX_MCP_RUN_CONTEXT_KEY, type MatrixMcpRunContext } from "../../chat/matrix-mcp-launch.js";

/** Copy client headers for Platform proxying; Run identity is always server-derived. */
export function integrationProxyHeaders(context: Context, routePrefix: string): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(context.req.header())) {
    const normalized = key.toLowerCase();
    if (normalized !== "host" && normalized !== "authorization"
      && normalized !== "x-matrix-mcp-run-id"
      && normalized !== "x-matrix-custom-mcp-approval-proof" && value) headers.set(key, value);
  }
  if (routePrefix === "/api/mcp-servers") {
    const run = context.get(MATRIX_MCP_RUN_CONTEXT_KEY as never) as MatrixMcpRunContext | undefined;
    if (run?.scope === "call") headers.set("x-matrix-mcp-run-id", run.runId);
  }
  return headers;
}
