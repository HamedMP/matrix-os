import type { Hono } from "hono";
import { z } from "zod/v4";
import type { HostedBotsManagedTool, HostedBotsManagedTools } from "./managed-tools.js";

const identifier = z.string().min(1).max(128);
const description = z.string().max(1000);
const parameter = z.object({
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  required: z.boolean().optional(),
});
const apps = z.object({ services: z.array(z.object({
  id: identifier, actions: z.array(z.object({
    id: identifier, description, params: z.record(identifier, parameter),
  })).max(100),
})).max(100) });
const mcpTool = z.object({
  name: identifier, description: z.string().max(8192).nullish(),
  inputSchema: z.object({ type: z.literal("object") }).loose(),
});
const mcps = z.object({ servers: z.array(z.object({
  id: identifier, name: identifier, tools: z.array(z.unknown()).max(200),
})).max(100) });
const MAX_SOURCE_TOOLS = 24;
const MAX_SCHEMA_BYTES = 4_096;

type BridgeTool = {
  definition: HostedBotsManagedTool;
  path: "/integration/read" | "/mcp/call";
  arguments: (input: Record<string, unknown>) => object;
};

/** An immutable per-turn name mapping. Gateway tools must still go through the owner decision broker. */
export function createHostedBotsManagedTools(routes: Pick<Hono, "request">): HostedBotsManagedTools {
  const tools = new Map<string, BridgeTool>();
  const get = async (path: string, signal: AbortSignal) => {
    try {
      const response = await routes.request(path, { signal });
      if (!response.ok) return undefined;
      return await response.json() as unknown;
    } catch (error) {
      signal.throwIfAborted();
      console.warn("[hosted-bots] Tool catalog unavailable", error instanceof Error ? error.name : "UnknownError");
      return undefined;
    }
  };
  return {
    async list(signal) {
      const [appsResult, mcpResult] = await Promise.all([
        get("/integration/catalog", signal), get("/mcp/catalog", signal),
      ]);
      const connectedApps = apps.safeParse(appsResult);
      const customMcp = mcps.safeParse(mcpResult);
      signal.throwIfAborted();
      let appCount = 0;
      for (const { service, action } of (connectedApps.data?.services ?? [])
        .flatMap(service => service.actions.map(action => ({ service, action }))).slice(0, MAX_SOURCE_TOOLS)) {
        const entries = Object.entries(action.params);
        const name = "matrix_app_" + ++appCount;
        tools.set(name, {
          definition: {
            name, description: service.id + " · " + action.description,
            parameters: {
              type: "object", additionalProperties: false,
              properties: Object.fromEntries(entries.map(([key, field]) => [
                key, field.type === "array" ? { type: "array", items: {} } : { type: field.type },
              ])),
              required: entries.filter(([, field]) => field.required).map(([key]) => key),
            },
          },
          path: "/integration/read", arguments: params => ({ service: service.id, action: action.id, params }),
        });
      }
      let mcpCount = 0;
      for (const { server, value } of (customMcp.data?.servers ?? [])
        .flatMap(server => server.tools.map(value => ({ server, value })))) {
        if (mcpCount >= MAX_SOURCE_TOOLS) break;
        const parsed = mcpTool.safeParse(value);
        if (!parsed.success) continue;
        const tool = parsed.data;
        if (Buffer.byteLength(JSON.stringify(tool.inputSchema)) > MAX_SCHEMA_BYTES) continue;
        const name = "matrix_mcp_" + ++mcpCount;
        tools.set(name, {
          definition: {
            name, description: server.name + " · " + tool.name + (tool.description ? ": " + tool.description.slice(0, 1000) : ""),
            parameters: tool.inputSchema,
          },
          path: "/mcp/call", arguments: input => ({ serverId: server.id, tool: tool.name, arguments: input }),
        });
      }
      return [...tools.values()].map(tool => tool.definition);
    },
    async call(name, args, _identity, signal) {
      signal.throwIfAborted();
      const tool = tools.get(name);
      if (!tool) return { error: "Tool unavailable." };
      const response = await routes.request(tool.path, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(tool.arguments(args)), signal,
      });
      if (!response.ok) return { error: response.status === 403 ? "Matrix did not approve this tool request." : "Tool unavailable." };
      return await response.json() as unknown;
    },
  };
}
