/** Dedicated native harness boundary: one run bearer, one trusted loopback route, no owner auth fallback. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { SharedBrowserActionSchema, SharedBrowserMcpActionInputSchema, SHARED_BROWSER_TOOL_DESCRIPTION, SharedBrowserActionResultSchema, SHARED_BROWSER_ACTION_DEADLINE_MS, SHARED_BROWSER_ACTION_MAX_BYTES, SHARED_BROWSER_UNCERTAIN_ACTION_MESSAGE } from "@matrix-os/contracts";
const MAX_BYTES = 192 * 1024;
export const SHARED_BROWSER_DESCRIPTION = SHARED_BROWSER_TOOL_DESCRIPTION;
const BEARER = /^[A-Za-z0-9_-]{43}$/;

/**
 * Codex follow-up turns renew the per-run bearer without restarting this server:
 * the runner rewrites a private (0600, runner-owned 0700 directory) file, and
 * each action reads the current bearer. A cleared, replaced-by-symlink, foreign,
 * or malformed file fails the action closed.
 */
export function createSharedBrowserTokenFileReader(path: string): () => Promise<string> {
  if (!isAbsolute(path)) throw new Error("Browser tool unavailable");
  return async () => {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      const uid = process.getuid?.();
      if (!info.isFile() || info.size > 128 || (uid !== undefined && info.uid !== uid) || (info.mode & 0o077) !== 0) throw new Error("Browser tool unavailable");
      const token = (await handle.readFile("utf8")).trim();
      if (!BEARER.test(token)) throw new Error("Browser tool unavailable");
      return token;
    } finally { await handle.close(); }
  };
}

export function createSharedBrowserMcpServer(options: { gatewayPort: number; token: string | (() => Promise<string>); fetcher?: typeof fetch }) {
  if (!Number.isInteger(options.gatewayPort) || options.gatewayPort < 1 || options.gatewayPort > 65535
    || (typeof options.token === "string" && !BEARER.test(options.token))) throw new Error("Browser tool unavailable");
  const currentToken = typeof options.token === "string" ? async () => options.token as string : options.token;
  const endpoint = `http://127.0.0.1:${options.gatewayPort}/apps/browser-lab/api/agent-action`;
  const server = new McpServer({ name: "matrix-shared-browser", version: "1.0.0" });
  server.registerTool("shared_browser", { description: SHARED_BROWSER_DESCRIPTION, inputSchema: SharedBrowserMcpActionInputSchema }, async (raw, extra) => {
    const signal = AbortSignal.any([extra.signal, AbortSignal.timeout(SHARED_BROWSER_ACTION_DEADLINE_MS)]);
    try {
      const action = SharedBrowserActionSchema.parse(raw);
      const body = JSON.stringify(action);
      if (Buffer.byteLength(body, "utf8") > SHARED_BROWSER_ACTION_MAX_BYTES) throw new Error("Browser tool unavailable");
      const token = await currentToken();
      if (!BEARER.test(token)) throw new Error("Browser tool unavailable");
      const response = await (options.fetcher ?? fetch)(endpoint, { method: "POST", redirect: "error", signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body });
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
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: SHARED_BROWSER_UNCERTAIN_ACTION_MESSAGE,
        }],
      };
    }
  });
  return server;
}
