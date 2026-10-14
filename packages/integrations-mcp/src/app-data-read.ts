import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { OWNER_APP_READ_PATH, OWNER_APP_READ_TOOL, OWNER_APP_READ_BODY_BYTES,
  OWNER_APP_READ_MAX_BYTES, OwnerAppReadInputSchema } from "@matrix-os/contracts";
import type { GatewayFetcher } from "../../kernel/dist/tools/integrations.js";

async function boundedResponse(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new Error("AppReadResponseUnavailable");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(error => console.warn("[app-data-read] Cleanup unavailable", error instanceof Error ? error.name : "UnknownError")); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = []; // <=64 KiB total, discarded after this response.
    let bytes = 0;
    let count = 0;
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      if (++count > 4096) throw new Error("AppReadResponseTooFragmented");
      bytes += chunk.value.byteLength;
      if (bytes > OWNER_APP_READ_MAX_BYTES) throw new Error("AppReadResponseTooLarge");
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

/** No gatewayAuthHeaders fallback: this tool requires a scoped run bearer. */
export function registerOwnerAppReadTool(server: McpServer, fetcher: GatewayFetcher = fetch): void {
  if (typeof fetcher !== "function") throw new Error("App read transport unavailable");
  server.registerTool(OWNER_APP_READ_TOOL, {
    description: "Discover granted installed apps/schema and read bounded owner app records. Read only; no SQL or credentials.",
    inputSchema: OwnerAppReadInputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async input => {
    const denied = { isError: true, content: [{ type: "text" as const, text: "App data read unavailable" }] };
    try {
      const token = process.env.MATRIX_AGENT_INTEGRATIONS_TOKEN;
      if (!token || !/^[a-f0-9]{64}$/.test(token)) return denied;
      const body = JSON.stringify(OwnerAppReadInputSchema.parse(input));
      if (Buffer.byteLength(body) > OWNER_APP_READ_BODY_BYTES) return denied;
      const signal = AbortSignal.timeout(10_000);
      const response = await fetcher(`${process.env.GATEWAY_URL ?? "http://localhost:4000"}${OWNER_APP_READ_PATH}`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body, signal, redirect: "error",
      });
      if (!(response instanceof Response)) return denied;
      if (!response.ok) {
        await response.body?.cancel();
        return denied;
      }
      const text = await boundedResponse(response, signal);
      JSON.parse(text); // Only forward structured responses, never an upstream error page.
      return { content: [{ type: "text" as const, text }] };
    } catch (error: unknown) {
      console.warn("[app-data-read] Tool unavailable", error instanceof Error ? error.name : "UnknownError");
      return denied;
    }
  });
}
