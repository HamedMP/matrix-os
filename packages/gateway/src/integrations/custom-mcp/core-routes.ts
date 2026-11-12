/** HTTP boundary for the Matrix Core MCP tools; mounted inside the Custom MCP routes. */
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { CORE_SEARCH_MAX_LIMIT } from "./core-catalog.js";
import { CORE_MAX_RESULT_BYTES, CORE_MIN_RESULT_BYTES, CoreToolsError, type CoreCaller, type CoreToolService } from "./core-tools.js";
import { CoreEntryPointSchema, CoreHarnessSchema } from "./core-usage.js";
import { CustomMcpBrokerError } from "./broker.js";

const BODY_LIMIT = 64 * 1024;
export const CoreServiceNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/);
export const CoreToolNameSchema = z.string().min(1).max(200);
const RunIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const SearchQuery = z.object({
  query: z.string().trim().min(1).max(200),
  service: CoreServiceNameSchema.optional(),
  limit: z.coerce.number().int().min(1).max(CORE_SEARCH_MAX_LIMIT).optional(),
}).strict();
const DescribeQuery = z.object({ service: CoreServiceNameSchema, tool: CoreToolNameSchema }).strict();
const CallBody = z.object({
  service: CoreServiceNameSchema,
  tool: CoreToolNameSchema,
  arguments: z.record(z.string().min(1).max(128), z.unknown()).optional(),
  approvalGranted: z.literal(false),
  approvalReceipt: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  maxResultBytes: z.number().int().min(CORE_MIN_RESULT_BYTES).max(CORE_MAX_RESULT_BYTES).optional(),
}).strict();

export interface CoreRouteOptions {
  core: CoreToolService;
  requireUser(context: Context, mutation?: boolean): Promise<string | Response>;
  resolveActorId?: (context: Context) => string | null;
  allowToolCalls?: boolean;
}

function coreError(context: Context, error: unknown): Response {
  if (error instanceof CoreToolsError) {
    return error.code === "not_found"
      ? context.json({ error: "Matrix Core MCP item not found" }, 404)
      : context.json({ error: "Invalid Matrix Core MCP request" }, 400);
  }
  if (error instanceof CustomMcpBrokerError) {
    if (error.code === "not_found" || error.code === "forbidden") return context.json({ error: "Matrix Core MCP tool unavailable" }, 403);
    if (error.code === "invalid") return context.json({ error: "Invalid Matrix Core MCP request" }, 400);
  }
  console.error("[core-mcp] route failed:", error instanceof Error ? error.message : String(error));
  return context.json({ error: "Matrix Core MCP request failed" }, 502);
}

/** Labels are analytics only; they never select authority. */
function caller(context: Context, userId: string, actorId: string | null | undefined): CoreCaller {
  const entry = CoreEntryPointSchema.safeParse(context.req.header("x-matrix-mcp-entry-point"));
  const harness = CoreHarnessSchema.safeParse(context.req.header("x-matrix-mcp-harness"));
  const runId = RunIdSchema.safeParse(context.req.header("x-matrix-mcp-run-id"));
  return {
    userId,
    actorId: actorId ?? userId,
    ...(runId.success ? { runId: runId.data } : {}),
    entryPoint: entry.success ? entry.data : "unknown",
    harness: harness.success ? harness.data : null,
  };
}

export function registerCoreMcpRoutes(app: Hono, options: CoreRouteOptions): void {
  const { core } = options;
  app.get("/core/services", async (context) => {
    const userId = await options.requireUser(context);
    if (typeof userId !== "string") return userId;
    try { return context.json({ services: await core.listServices(userId) }); }
    catch (error: unknown) { return coreError(context, error); }
  });

  app.get("/core/search", async (context) => {
    const userId = await options.requireUser(context);
    if (typeof userId !== "string") return userId;
    const parsed = SearchQuery.safeParse(context.req.query());
    if (!parsed.success) return context.json({ error: "Invalid Matrix Core MCP request" }, 400);
    try { return context.json(await core.searchTools(userId, parsed.data)); }
    catch (error: unknown) { return coreError(context, error); }
  });

  app.get("/core/describe", async (context) => {
    const userId = await options.requireUser(context);
    if (typeof userId !== "string") return userId;
    const parsed = DescribeQuery.safeParse(context.req.query());
    if (!parsed.success) return context.json({ error: "Invalid Matrix Core MCP request" }, 400);
    try { return context.json(await core.describeTool(userId, parsed.data.service, parsed.data.tool)); }
    catch (error: unknown) { return coreError(context, error); }
  });

  if (!options.allowToolCalls) return;

  app.post("/core/call", bodyLimit({ maxSize: BODY_LIMIT }), async (context) => {
    const userId = await options.requireUser(context, true);
    if (typeof userId !== "string") return userId;
    let body: unknown;
    try { body = await context.req.json(); }
    catch (error: unknown) {
      if (error instanceof Error && error.name === "BodyLimitError") throw error;
      console.warn("[core-mcp] call body parse failed:", error instanceof Error ? error.name : typeof error);
      return context.json({ error: "Invalid request body" }, 400);
    }
    if (body && typeof body === "object" && !Array.isArray(body) && (body as Record<string, unknown>).approvalGranted === true) {
      return context.json({ error: "Tool approval is unavailable" }, 403);
    }
    const parsed = CallBody.safeParse(body);
    if (!parsed.success) return context.json({ error: "Invalid request body" }, 400);
    try {
      return context.json(await core.callTool(caller(context, userId, options.resolveActorId?.(context)), {
        service: parsed.data.service, tool: parsed.data.tool, arguments: parsed.data.arguments,
        approvalReceipt: parsed.data.approvalReceipt, maxResultBytes: parsed.data.maxResultBytes,
        signal: context.req.raw.signal,
      }));
    } catch (error: unknown) { return coreError(context, error); }
  });

  app.get("/core/approvals/:approvalId", async (context) => {
    const userId = await options.requireUser(context);
    if (typeof userId !== "string") return userId;
    const approvalId = z.uuid().safeParse(context.req.param("approvalId"));
    if (!approvalId.success) return context.json({ error: "Matrix Core MCP item not found" }, 404);
    try { return context.json(await core.getApproval(caller(context, userId, options.resolveActorId?.(context)), approvalId.data)); }
    catch (error: unknown) { return coreError(context, error); }
  });
}

export { caller as coreCallerFromContext };
