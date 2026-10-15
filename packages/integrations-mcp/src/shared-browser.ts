/** Dedicated native harness boundary: one run bearer, one trusted loopback route, no owner auth fallback. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SharedBrowserActionSchema, SHARED_BROWSER_TOOL_DESCRIPTION, SharedBrowserActionResultSchema, SHARED_BROWSER_ACTION_DEADLINE_MS, SHARED_BROWSER_ACTION_MAX_BYTES } from "@matrix-os/contracts";
const MAX_BYTES = 192 * 1024;
export const SHARED_BROWSER_DESCRIPTION = SHARED_BROWSER_TOOL_DESCRIPTION;
export function createSharedBrowserMcpServer(options: { gatewayPort: number; token: string; fetcher?: typeof fetch }) {
  if (!Number.isInteger(options.gatewayPort) || options.gatewayPort < 1 || options.gatewayPort > 65535 || !/^[A-Za-z0-9_-]{43}$/.test(options.token)) throw new Error("Browser tool unavailable");
  const endpoint = `http://127.0.0.1:${options.gatewayPort}/apps/browser-lab/api/agent-action`;
  const server = new McpServer({ name: "matrix-shared-browser", version: "1.0.0" });
  server.registerTool("shared_browser", { description: SHARED_BROWSER_DESCRIPTION, inputSchema: SharedBrowserActionSchema }, async (raw, extra) => {
    const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(SHARED_BROWSER_ACTION_DEADLINE_MS)]);
    try {
      const action = SharedBrowserActionSchema.parse(raw);
      const body = JSON.stringify(action);
      if (Buffer.byteLength(body, "utf8") > SHARED_BROWSER_ACTION_MAX_BYTES) throw new Error("Browser tool unavailable");
      const response = await (options.fetcher ?? fetch)(endpoint, { method: "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" }, body });
      if (!response.ok || Number(response.headers.get("content-length")) > MAX_BYTES || !response.body) { await response.body?.cancel(); throw new Error("Browser tool unavailable"); }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
      const abort = () => { void reader.cancel().catch((error: unknown) => console.warn("[shared-browser-mcp] Body cancellation failed", error instanceof Error ? error.name : "UnknownError")); };
      signal.addEventListener("abort", abort, { once: true });
      try { for (;;) { signal.throwIfAborted(); const { done, value } = await reader.read(); signal.throwIfAborted(); if (done) break;
        length += value.byteLength; if (length > MAX_BYTES) { await reader.cancel(); throw new Error("Browser tool unavailable"); } chunks.push(value); }
      } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
      const result = SharedBrowserActionResultSchema.parse(JSON.parse(Buffer.concat(chunks, length).toString("utf8")));
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    } catch (error: unknown) {
      console.warn("[shared-browser-mcp] Action unavailable", error instanceof Error ? error.name : "UnknownError");
      return { isError: true, content: [{ type: "text" as const, text: "Browser action unavailable. If the owner paused or took over, stop until they resume; then obtain a fresh snapshot before continuing. Never replay an uncertain action." }] };
    }
  });
  return server;
}
