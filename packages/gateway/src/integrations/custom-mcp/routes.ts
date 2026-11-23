import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { CUSTOM_MCP_UNAVAILABLE } from "@matrix-os/contracts";
import { CustomMcpBroker, CustomMcpBrokerError } from "./broker.js";
import { MCP_TOOL_STREAM_TYPE } from "./tool-progress.js";
import { toolProgressResponse } from "./tool-progress-response.js";
import { REMOTE_MCP_DEPARTMENTS } from "@matrix-os/contracts/remote-mcp-catalog";
import {
  RegisteredMcpOAuthClients,
  listConnectableCatalogPresets,
  resolveConnectableCatalogPreset,
} from "./catalog-presets.js";
import { coreCallerFromContext, registerCoreMcpRoutes } from "./core-routes.js";
import { registerCoreOwnerApprovalRoutes } from "./core-owner-approval-routes.js";
import type { CustomMcpExternalApprovalStore } from "./external-approval-store.js";
import type { CoreToolService } from "./core-tools.js";

const MUTATION_BODY_LIMIT = 64 * 1024;
const UUID = z.uuid();
const ToolSelectionSchema = z.object({
  name: z.string().min(1).max(128),
  enabled: z.boolean(),
  approval: z.enum(["always_ask", "allow"]),
}).strict();
const CreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  url: z.url().max(2_048),
  authMode: z.enum(["none", "oauth", "bearer", "api_key"]),
  credential: z.string().min(1).max(8_192).optional(),
}).strict().superRefine((value, context) => {
  const needsCredential = value.authMode === "bearer" || value.authMode === "api_key";
  if (needsCredential !== Boolean(value.credential)) {
    context.addIssue({
      code: "custom",
      path: ["credential"],
      message: needsCredential ? "Credential is required" : "Credential is not accepted for this auth mode",
    });
  }
});
/** A preset pre-fills URL and auth; the caller may only rename it. */
const CatalogCreateSchema = z.object({
  catalogId: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  name: z.string().trim().min(1).max(100).optional(),
}).strict();
const CatalogQuerySchema = z.object({
  category: z.string().regex(/^[a-z][a-z_]{1,29}$/).optional(),
  department: z.enum(REMOTE_MCP_DEPARTMENTS).optional(),
}).strict();
const PatchSchema = z.object({
  revision: z.number().int().min(1),
  name: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  tools: z.array(ToolSelectionSchema).max(100).optional(),
}).strict();
const OAuthCallbackSchema = z.object({
  state: z.string().min(32).max(512),
  code: z.string().min(1).max(4_096),
}).strict();
const ToolCallSchema = z.object({
  tool: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()).optional(),
  approvalGranted: z.literal(false),
  approvalReceipt: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export interface CustomMcpOAuthFlow {
  start(userId: string, serverId: string): Promise<string>;
  complete(state: string, code: string): Promise<{ serverId: string }>;
}

export interface CustomMcpRoutesOptions {
  broker: CustomMcpBroker;
  resolveUserId: (context: Context) => Promise<string | null>;
  /** An outer authenticated router may classify missing account state as unavailable. */
  unavailableUserStatus?: 503;
  resolveActorId?: (context: Context) => string | null;
  oauth?: CustomMcpOAuthFlow;
  allowToolCalls?: boolean;
  /** Matrix-owned OAuth apps; without it only DCR and no-auth presets are offered. */
  catalog?: RegisteredMcpOAuthClients;
  /** Matrix Core MCP tools; legacy server-id calls also dispatch through it for usage records. */
  core?: CoreToolService;
  /** Owner-session router only (never the VPS-internal one): decides external-client writes. */
  ownerApprovals?: CustomMcpExternalApprovalStore;
  now?: () => number;
}

interface RateState { count: number; resetAt: number }

export function createCustomMcpRoutes(options: CustomMcpRoutesOptions): Hono {
  const app = new Hono();
  const rateStates = new Map<string, RateState>();
  const now = options.now ?? Date.now;
  const catalog = options.catalog ?? RegisteredMcpOAuthClients.empty();

  function checkRateLimit(userId: string): boolean {
    const current = now();
    const existing = rateStates.get(userId);
    if (!existing || current >= existing.resetAt) {
      if (!existing && rateStates.size >= 10_000) {
        const oldest = rateStates.keys().next().value as string | undefined;
        if (oldest) rateStates.delete(oldest);
      }
      rateStates.set(userId, { count: 1, resetAt: current + 60_000 });
      return true;
    }
    if (existing.count >= 60) return false;
    existing.count += 1;
    rateStates.delete(userId);
    rateStates.set(userId, existing);
    return true;
  }

  async function requireUser(context: Context, mutation = false): Promise<string | Response> {
    const userId = await options.resolveUserId(context);
    if (!userId) return options.unavailableUserStatus === 503
      ? context.json({ error: CUSTOM_MCP_UNAVAILABLE }, 503)
      : context.json({ error: "Unauthorized" }, 401);
    if (mutation && !checkRateLimit(userId)) {
      return context.json({ error: "Too many requests" }, 429);
    }
    return userId;
  }

  function brokerError(context: Context, error: unknown): Response {
    if (error instanceof CustomMcpBrokerError) {
      if (error.code === "not_found" || error.code === "forbidden") {
        return context.json({ error: "Custom MCP server not found" }, 404);
      }
      if (error.code === "conflict") {
        return context.json({ error: "Revision conflict" }, 409);
      }
      if (error.code === "invalid") {
        return context.json({ error: "Invalid Custom MCP request" }, 400);
      }
      if (error.code === "action_required") {
        return context.json({ error: "Action required" }, 409);
      }
      if (error.code === "oauth_client_setup_required") {
        return context.json({ error: "Administrator setup is required before sign-in", code: "oauth_client_setup_required" }, 409);
      }
    }
    console.error("[custom-mcp] route failed:", error instanceof Error ? error.message : String(error));
    return context.json({ error: "Custom MCP request failed" }, 502);
  }

  function createInput(body: unknown) {
    if (body && typeof body === "object" && !Array.isArray(body) && Object.hasOwn(body, "catalogId")) {
      const preset = CatalogCreateSchema.safeParse(body);
      const entry = preset.success ? resolveConnectableCatalogPreset(catalog, preset.data.catalogId) : undefined;
      if (!preset.success || !entry) return undefined;
      return { name: preset.data.name ?? entry.name, url: entry.url, authMode: entry.auth === "none" ? "none" as const : "oauth" as const };
    }
    const parsed = CreateSchema.safeParse(body);
    return parsed.success ? parsed.data : undefined;
  }

  // Registered before "/:id" routes so "/core/*" never reaches server-id handlers.
  if (options.core) {
    registerCoreMcpRoutes(app, { core: options.core, requireUser, resolveActorId: options.resolveActorId,
      allowToolCalls: options.allowToolCalls });
  }
  if (options.ownerApprovals) {
    registerCoreOwnerApprovalRoutes(app, { store: options.ownerApprovals, requireUser,
      listServers: userId => options.broker.list(userId) });
  }

  app.get("/", async (context) => {
    const userId = await requireUser(context);
    if (typeof userId !== "string") return userId;
    try {
      return context.json(await options.broker.list(userId));
    } catch (error) {
      return brokerError(context, error);
    }
  });

  app.get("/oauth/callback", async (context) => {
    const parsed = OAuthCallbackSchema.safeParse({
      state: context.req.query("state"),
      code: context.req.query("code"),
    });
    if (!parsed.success) return context.json({ error: "Invalid OAuth callback" }, 400);
    if (!options.oauth) return context.json({ error: "Custom MCP OAuth unavailable" }, 503);
    try {
      const result = await options.oauth.complete(parsed.data.state, parsed.data.code);
      return context.json({ ok: true, serverId: result.serverId });
    } catch (error) {
      return brokerError(context, error);
    }
  });

  app.get("/catalog", async (context) => {
    const userId = await requireUser(context);
    if (typeof userId !== "string") return userId;
    const parsed = CatalogQuerySchema.safeParse(context.req.query());
    if (!parsed.success) return context.json({ error: "Invalid catalog filter" }, 400);
    context.header("Cache-Control", "private, no-store");
    return context.json({ presets: listConnectableCatalogPresets(catalog, parsed.data) });
  });

  app.get("/:id", async (context) => {
    const userId = await requireUser(context);
    if (typeof userId !== "string") return userId;
    const parsedId = UUID.safeParse(context.req.param("id"));
    if (!parsedId.success) return context.json({ error: "Custom MCP server not found" }, 404);
    try {
      return context.json(await options.broker.describe(userId, parsedId.data));
    } catch (error) {
      return brokerError(context, error);
    }
  });

  app.post("/", bodyLimit({ maxSize: MUTATION_BODY_LIMIT }), async (context) => {
    const userId = await requireUser(context, true);
    if (typeof userId !== "string") return userId;
    let body: unknown;
    try {
      body = await context.req.json();
    } catch (parseError: unknown) {
      console.warn(
        "[custom-mcp] create body parse failed:",
        parseError instanceof Error ? parseError.name : typeof parseError,
      );
      return context.json({ error: "Invalid request body" }, 400);
    }
    const input = createInput(body);
    if (!input) return context.json({ error: "Invalid request body" }, 400);
    try {
      return context.json(await options.broker.create(userId, input), 201);
    } catch (error) {
      return brokerError(context, error);
    }
  });

  app.patch("/:id", bodyLimit({ maxSize: MUTATION_BODY_LIMIT }), async (context) => {
    const userId = await requireUser(context, true);
    if (typeof userId !== "string") return userId;
    const parsedId = UUID.safeParse(context.req.param("id"));
    if (!parsedId.success) return context.json({ error: "Custom MCP server not found" }, 404);
    let body: unknown;
    try {
      body = await context.req.json();
    } catch (parseError: unknown) {
      console.warn(
        "[custom-mcp] patch body parse failed:",
        parseError instanceof Error ? parseError.name : typeof parseError,
      );
      return context.json({ error: "Invalid request body" }, 400);
    }
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "Invalid request body" }, 400);
    try {
      return context.json(await options.broker.patch(userId, parsedId.data, parsed.data));
    } catch (error) {
      return brokerError(context, error);
    }
  });

  app.delete("/:id", bodyLimit({ maxSize: MUTATION_BODY_LIMIT }), async (context) => {
    const userId = await requireUser(context, true);
    if (typeof userId !== "string") return userId;
    const parsedId = UUID.safeParse(context.req.param("id"));
    if (!parsedId.success) return context.json({ error: "Custom MCP server not found" }, 404);
    try {
      await options.broker.remove(userId, parsedId.data);
      return context.json({ ok: true });
    } catch (error) {
      return brokerError(context, error);
    }
  });

  app.post("/:id/connect", bodyLimit({ maxSize: MUTATION_BODY_LIMIT }), async (context) => {
    const userId = await requireUser(context, true);
    if (typeof userId !== "string") return userId;
    const parsedId = UUID.safeParse(context.req.param("id"));
    if (!parsedId.success) return context.json({ error: "Custom MCP server not found" }, 404);
    if (!options.oauth) return context.json({ error: "Custom MCP OAuth unavailable" }, 503);
    try {
      return context.json({ url: await options.oauth.start(userId, parsedId.data) });
    } catch (error) {
      return brokerError(context, error);
    }
  });

  async function discover(context: Context): Promise<Response> {
    const userId = await requireUser(context, true);
    if (typeof userId !== "string") return userId;
    const parsedId = UUID.safeParse(context.req.param("id"));
    if (!parsedId.success) return context.json({ error: "Custom MCP server not found" }, 404);
    try {
      return context.json(await options.broker.discover(userId, parsedId.data));
    } catch (error) {
      return brokerError(context, error);
    }
  }

  app.post("/:id/sync", bodyLimit({ maxSize: MUTATION_BODY_LIMIT }), discover);
  app.post("/:id/discover", bodyLimit({ maxSize: MUTATION_BODY_LIMIT }), discover);
  app.post("/:id/test", bodyLimit({ maxSize: MUTATION_BODY_LIMIT }), async (context) => {
    const userId = await requireUser(context, true);
    if (typeof userId !== "string") return userId;
    const parsedId = UUID.safeParse(context.req.param("id"));
    if (!parsedId.success) return context.json({ error: "Custom MCP server not found" }, 404);
    try {
      return context.json(await options.broker.test(userId, parsedId.data));
    } catch (error) {
      return brokerError(context, error);
    }
  });

  if (options.allowToolCalls) {
    const core = options.core;
    app.post("/:id/call", bodyLimit({ maxSize: MUTATION_BODY_LIMIT }), async (context) => {
      const userId = await requireUser(context, true);
      if (typeof userId !== "string") return userId;
      const parsedId = UUID.safeParse(context.req.param("id"));
      if (!parsedId.success) return context.json({ error: "Custom MCP server not found" }, 404);
      let body: unknown;
      try {
        body = await context.req.json();
      } catch (parseError: unknown) {
        console.warn(
          "[custom-mcp] tool-call body parse failed:",
          parseError instanceof Error ? parseError.name : typeof parseError,
        );
        return context.json({ error: "Invalid request body" }, 400);
      }
      const parsed = ToolCallSchema.safeParse(body);
      if (body && typeof body === "object" && !Array.isArray(body)
        && (body as Record<string, unknown>).approvalGranted === true) {
        return context.json({ error: "Tool approval is unavailable" }, 403);
      }
      if (!parsed.success) return context.json({ error: "Invalid request body" }, 400);
      if (context.req.header("accept") === MCP_TOOL_STREAM_TYPE) {
        return toolProgressResponse(context.req.raw.signal, (onProgress, signal) => core
          ? core.dispatch(coreCallerFromContext(context, userId, options.resolveActorId?.(context)), {
            serverId: parsedId.data, tool: parsed.data.tool, arguments: parsed.data.arguments,
            approvalReceipt: parsed.data.approvalReceipt, onProgress, signal,
          })
          : options.broker.callSelectedTool({
            userId, serverId: parsedId.data, toolName: parsed.data.tool, arguments: parsed.data.arguments,
            approvalGranted: parsed.data.approvalGranted, approvalReceipt: parsed.data.approvalReceipt,
            actorId: options.resolveActorId?.(context) ?? undefined, runId: context.req.header("x-matrix-mcp-run-id"),
            onProgress, signal,
          }));
      }
      try {
        if (core) {
          return context.json(await core.dispatch(coreCallerFromContext(context, userId, options.resolveActorId?.(context)), {
            serverId: parsedId.data, tool: parsed.data.tool, arguments: parsed.data.arguments,
            approvalReceipt: parsed.data.approvalReceipt, signal: context.req.raw.signal,
          }));
        }
        return context.json(await options.broker.callSelectedTool({
          userId,
          serverId: parsedId.data,
          toolName: parsed.data.tool,
          arguments: parsed.data.arguments,
          approvalGranted: parsed.data.approvalGranted,
          approvalReceipt: parsed.data.approvalReceipt,
          actorId: options.resolveActorId?.(context) ?? undefined,
          runId: context.req.header("x-matrix-mcp-run-id"),
        }));
      } catch (error) {
        return brokerError(context, error);
      }
    });
  }

  return app;
}
