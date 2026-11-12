/** Typed server-only Platform transport; saved tool policy/SSRF/Preview rules stay upstream. */
import { z } from "zod/v4";
import { delegatedIntegrationHeaders } from "../integrations/delegated-identity.js";
import { MCP_TOOL_STREAM_TYPE, MCP_TOOL_STREAM_MAX_BYTES, McpToolStreamFrameSchema, type McpProgressListener } from "../integrations/custom-mcp/tool-progress.js";
const Tool = z.object({ name: z.string().min(1).max(128), description: z.string().max(8192), inputSchema: z.unknown(), approval: z.enum(["allow", "always_ask"]), enabled: z.boolean() }).passthrough();
const Server = z.object({ id: z.uuid(), name: z.string().max(100), status: z.string().max(32), enabled: z.boolean(), tools: z.array(Tool).max(100) }).passthrough();
const SearchResult = z.object({
  results: z.array(z.object({ serverId: z.uuid(), service: z.string().max(64), tool: z.string().min(1).max(128),
    qualifiedName: z.string().max(200), description: z.string().max(200), policy: z.enum(["allow", "always_ask"]) })).max(25),
  skipped: z.array(z.object({ service: z.string().max(64), reason: z.string().max(32) })).max(100),
});
const MAX_BYTES = 192 * 1024;
export interface ManagedPiMcpClient {
  inventory(ownerId: string, signal: AbortSignal): Promise<unknown>;
  describe(ownerId: string, serverId: string, signal: AbortSignal): Promise<unknown>;
  search(ownerId: string, input: { query: string; service?: string }, signal: AbortSignal): Promise<unknown>;
  call(ownerId: string, input: { serverId: string; tool: string; arguments: Record<string, unknown>; runId: string; approvalReceipt?: string }, signal: AbortSignal, onProgress?: McpProgressListener): Promise<unknown>;
}
export function createManagedPiMcpClient(options: { platformUrl: string; handle: string; token: string; ownerId: string; fetcher?: typeof fetch }): ManagedPiMcpClient {
  const base = new URL(options.platformUrl);
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.handle) || !options.token || !options.ownerId) throw new Error("MCP unavailable");
  const endpoint = new URL(`/internal/containers/${options.handle}/mcp-servers`, base);
  async function send(ownerId: string, suffix: string, signal: AbortSignal, input?: { runId: string; body: Record<string, unknown> }, onProgress?: McpProgressListener) {
    if (ownerId !== options.ownerId || signal.aborted) throw new Error("MCP unavailable");
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(input ? 30_000 : 10_000)]);
    const response = await (options.fetcher ?? fetch)(`${endpoint}${suffix}`, { method: input ? "POST" : "GET", redirect: "error",
      signal: bounded,
      headers: { authorization: `Bearer ${options.token}`, ...delegatedIntegrationHeaders(ownerId, options.token),
        // Usage labels only; authority stays the machine bearer + delegated owner.
        "x-matrix-mcp-entry-point": "managed_pi", "x-matrix-mcp-harness": "pi",
        ...(onProgress ? { accept: MCP_TOOL_STREAM_TYPE } : {}),
        ...(input ? { "content-type": "application/json", "x-matrix-mcp-run-id": input.runId } : {}) },
      ...(input ? { body: JSON.stringify(input.body) } : {}) });
    const streaming = response.headers.get("content-type")?.split(";")[0] === MCP_TOOL_STREAM_TYPE;
    if (!response.ok || Number(response.headers.get("content-length")) > (streaming ? MCP_TOOL_STREAM_MAX_BYTES : MAX_BYTES)) { await response.body?.cancel(); throw new Error("MCP unavailable"); }
    if (bounded.aborted) { await response.body?.cancel(); throw new Error("MCP unavailable"); }
    if (!response.body) throw new Error("MCP unavailable");
    const reader = response.body.getReader(); let length = 0; const chunks: Uint8Array[] = [];
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = ""; let updates = 0; let final = false; let result: unknown;
    const abort = () => { void reader.cancel().catch((error: unknown) => console.warn("[managed-pi] MCP body cancellation failed", error instanceof Error ? error.name : "UnknownError")); };
    bounded.addEventListener("abort", abort, { once: true });
    try { for (;;) { const { done, value } = await reader.read(); if (bounded.aborted) throw new Error("MCP unavailable");
      if (done) break; length += value.byteLength;
      if (length > (streaming ? MCP_TOOL_STREAM_MAX_BYTES : MAX_BYTES)) { await reader.cancel(); throw new Error("MCP unavailable"); }
      if (!streaming) { chunks.push(value); continue; }
      pending += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const frame = McpToolStreamFrameSchema.parse(JSON.parse(pending.slice(0, newline)));
        pending = pending.slice(newline + 1);
        if (final || frame.type === "error") throw new Error("MCP unavailable");
        if (frame.type === "result") {
          if (new TextEncoder().encode(JSON.stringify(frame.result)).byteLength > MAX_BYTES) throw new Error("MCP unavailable");
          final = true; result = frame.result;
        } else {
          if (++updates > 3) throw new Error("MCP unavailable");
          onProgress?.({ progress: frame.progress, ...(frame.total !== undefined ? { total: frame.total } : {}), ...(frame.message !== undefined ? { message: frame.message } : {}) });
        }
      }
    }
    } catch (error: unknown) {
      await reader.cancel();
      throw new Error("MCP unavailable", { cause: error });
    } finally { bounded.removeEventListener("abort", abort); reader.releaseLock(); }
    if (streaming) {
      if (decoder.decode() || pending || !final) throw new Error("MCP unavailable");
      return result;
    }
    return JSON.parse(Buffer.concat(chunks, length).toString("utf8")) as unknown;
  }
  function projection(raw: unknown) {
    const row = Server.parse(raw);
    return { id: row.id, name: row.name, status: row.status, enabled: row.enabled,
      tools: row.tools.filter(tool => tool.enabled).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, approval: tool.approval })) };
  }
  return {
    async inventory(ownerId, signal) { return z.array(Server).max(100).parse(await send(ownerId, "", signal)).map(row => projection(row)); },
    async search(ownerId, input, signal) {
      const query = new URLSearchParams({ query: z.string().min(1).max(200).parse(input.query) });
      if (input.service) query.set("service", z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).parse(input.service));
      const parsed = SearchResult.parse(await send(ownerId, `/core/search?${query}`, signal));
      return { results: parsed.results.map(hit => ({ serverId: hit.serverId, service: hit.service, tool: hit.tool,
        qualifiedName: hit.qualifiedName, description: hit.description, approval: hit.policy })), skipped: parsed.skipped };
    },
    async describe(ownerId, serverId, signal) { return projection(await send(ownerId, `/${z.uuid().parse(serverId)}`, signal)); },
    async call(ownerId, input, signal, onProgress) { return send(ownerId, `/${z.uuid().parse(input.serverId)}/call`, signal, { runId: input.runId,
      body: { tool: input.tool, arguments: input.arguments, approvalGranted: false, ...(input.approvalReceipt ? { approvalReceipt: input.approvalReceipt } : {}) } }, onProgress); },
  };
}
