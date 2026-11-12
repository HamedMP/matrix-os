import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { PlatformDb } from "../../platform-db.js";
import { CustomMcpBroker, CustomMcpBrokerError } from "./broker.js";
import { assignCoreServiceSlugs } from "./core-catalog.js";

const BODY_LIMIT = 64 * 1024;
const RunId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const ApprovalId = z.uuid();
const RegisterBody = z.object({ runId: RunId }).strict();
const Generation = z.number().int().min(1).max(2_147_483_647);
const PrepareBody = z.object({
  generation: Generation,
  nativeRequestId: z.string().min(1).max(256),
  serverId: z.uuid().optional(),
  // Matrix Core MCP call_tool (spec 2691) names a service slug, resolved here against the owner's servers.
  service: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  tool: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).optional(),
}).strict().refine(body => (body.serverId === undefined) !== (body.service === undefined)
  && (body.service !== undefined || body.tool.length <= 128));
const DecisionBody = z.object({
  decision: z.enum(["approve", "decline", "cancel"]),
  chatId: z.string().min(1).max(128).optional(),
  clientRequestId: z.string().min(1).max(128).optional(),
}).strict();

export function createCustomMcpApprovalRoutes(options: {
  db: PlatformDb;
  broker: CustomMcpBroker;
  resolvePrincipal: (context: Context) => Promise<{ userId: string; actorId: string; handle: string } | null>;
  verifyDecisionProof: (proof: string | undefined, input: {
    handle: string; actorId: string; chatId: string; runId: string; approvalId: string;
    decision: "approve" | "decline" | "cancel"; clientRequestId: string;
  }) => boolean;
}): Hono {
  const app = new Hono();
  app.onError((error, context) => {
    if (error instanceof Error && error.name === "BodyLimitError") {
      return context.json({ error: "Approval request too large" }, 413);
    }
    console.warn("[custom-mcp] approval route failed", error instanceof Error ? error.name : typeof error);
    return context.json({ error: "Custom MCP approval unavailable" }, 503);
  });
  app.use("*", bodyLimit({ maxSize: BODY_LIMIT }), async (context, next) => {
    context.header("Cache-Control", "no-store");
    await next();
  });

  async function principal(context: Context) {
    return options.resolvePrincipal(context);
  }

  async function body(context: Context): Promise<unknown> {
    try { return await context.req.json(); }
    catch (error: unknown) {
      if (error instanceof SyntaxError) return null;
      if (error instanceof Error && error.name === "BodyLimitError") throw error;
      console.warn("[custom-mcp] approval body read failed", error instanceof Error ? error.name : typeof error);
      throw error;
    }
  }

  function failed(context: Context, error: unknown): Response {
    if (error instanceof CustomMcpBrokerError
      && (error.code === "forbidden" || error.code === "not_found" || error.code === "invalid")) {
      return context.json({ error: "Custom MCP approval unavailable" }, 403);
    }
    console.warn("[custom-mcp] approval route failed", error instanceof Error ? error.name : typeof error);
    return context.json({ error: "Custom MCP approval unavailable" }, 503);
  }

  /** Same slug assignment as the Core tool service, so the approval binds the server the call will reach. */
  async function coreTarget(userId: string, service: string, tool: string): Promise<{ serverId: string; toolName: string }> {
    const slugs = assignCoreServiceSlugs(await options.broker.list(userId));
    const serverId = [...slugs].find(([, slug]) => slug === service)?.[0];
    if (!serverId) throw new CustomMcpBrokerError("not_found");
    const toolName = tool.startsWith(`${service}.`) ? tool.slice(service.length + 1) : tool;
    if (!toolName || toolName.length > 128) throw new CustomMcpBrokerError("invalid");
    return { serverId, toolName };
  }

  app.post("/runs", async (context) => {
    const identity = await principal(context);
    if (!identity) return context.json({ error: "Unauthorized" }, 401);
    const parsed = RegisterBody.safeParse(await body(context));
    if (!parsed.success) return context.json({ error: "Invalid request body" }, 400);
    try {
      const lease = await options.db.registerCustomMcpRunLease({
        ...identity, runId: parsed.data.runId, expiresAt: new Date(Date.now() + 35 * 60_000),
      });
      return lease ? context.json({ registered: true, generation: lease.generation })
        : context.json({ error: "Custom MCP approval unavailable" }, 409);
    } catch (error) { return failed(context, error); }
  });

  app.post("/runs/:runId/prepare", async (context) => {
    const identity = await principal(context);
    if (!identity) return context.json({ error: "Unauthorized" }, 401);
    const runId = RunId.safeParse(context.req.param("runId"));
    const parsed = PrepareBody.safeParse(await body(context));
    if (!runId.success || !parsed.success) return context.json({ error: "Invalid request body" }, 400);
    try {
      const target = parsed.data.service === undefined
        ? { serverId: parsed.data.serverId!, toolName: parsed.data.tool }
        : await coreTarget(identity.userId, parsed.data.service, parsed.data.tool);
      return context.json(await options.broker.prepareToolApproval({
        ...identity, runId: runId.data, generation: parsed.data.generation,
        nativeRequestId: parsed.data.nativeRequestId,
        ...target,
        arguments: parsed.data.arguments,
      }));
    } catch (error) { return failed(context, error); }
  });

  app.post("/runs/:runId/decisions/:approvalId", async (context) => {
    const identity = await principal(context);
    if (!identity) return context.json({ error: "Unauthorized" }, 401);
    const runId = RunId.safeParse(context.req.param("runId"));
    const approvalId = ApprovalId.safeParse(context.req.param("approvalId"));
    const parsed = DecisionBody.safeParse(await body(context));
    if (!runId.success || !approvalId.success || !parsed.success) {
      return context.json({ error: "Invalid request body" }, 400);
    }
    const proof = context.req.header("x-matrix-custom-mcp-approval-proof");
    const proofInput = parsed.data.chatId && parsed.data.clientRequestId ? {
      handle: identity.handle, actorId: identity.actorId, chatId: parsed.data.chatId,
      runId: runId.data, approvalId: approvalId.data,
      decision: parsed.data.decision, clientRequestId: parsed.data.clientRequestId,
    } : null;
    const requireProof = parsed.data.decision !== "cancel" || Boolean(proof);
    if (requireProof && (!proofInput || !options.verifyDecisionProof(proof, proofInput))) {
      return context.json({ error: "Custom MCP approval unavailable" }, 403);
    }
    try {
      const decision = await options.db.decideCustomMcpToolApproval({
        ...identity, runId: runId.data, approvalId: approvalId.data, decision: parsed.data.decision,
        ...(requireProof ? { validateDecisionProof: () => options.verifyDecisionProof(proof, proofInput!) } : {}),
      });
      return decision ? context.json(decision)
        : context.json({ error: "Custom MCP approval unavailable" }, 409);
    } catch (error) { return failed(context, error); }
  });

  app.post("/runs/:runId/revoke", async (context) => {
    const identity = await principal(context);
    if (!identity) return context.json({ error: "Unauthorized" }, 401);
    const runId = RunId.safeParse(context.req.param("runId"));
    const parsed = z.object({}).strict().safeParse(await body(context));
    if (!runId.success || !parsed.success) return context.json({ error: "Invalid request body" }, 400);
    try {
      const revoked = await options.db.revokeCustomMcpRunLease({ ...identity, runId: runId.data });
      return revoked ? context.json({ revoked: true })
        : context.json({ error: "Custom MCP approval unavailable" }, 409);
    } catch (error) { return failed(context, error); }
  });

  app.post("/runs/:runId/clear", async (context) => {
    const identity = await principal(context);
    if (!identity) return context.json({ error: "Unauthorized" }, 401);
    const runId = RunId.safeParse(context.req.param("runId"));
    const parsed = z.object({ generation: Generation }).strict().safeParse(await body(context));
    if (!runId.success || !parsed.success) return context.json({ error: "Invalid request body" }, 400);
    try {
      const cleared = await options.db.clearCustomMcpRunApprovals({
        ...identity, runId: runId.data, generation: parsed.data.generation,
      });
      return cleared ? context.json(cleared)
        : context.json({ error: "Custom MCP approval unavailable" }, 409);
    } catch (error) { return failed(context, error); }
  });

  return app;
}
