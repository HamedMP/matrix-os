/**
 * Owner-session decisions for external Matrix Core MCP writes (spec 2691).
 *
 * Mounted only on the Platform's session-routed `/api/mcp-servers` router.
 * The VPS-internal router never registers it, so no run bearer, machine
 * bearer, or external `/mcp` OAuth bearer can reach the approve action: an
 * external client cannot approve its own call.
 */
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { assignCoreServiceSlugs } from "./core-catalog.js";
import type { CustomMcpServer } from "./types.js";
import type { CustomMcpExternalApprovalStore } from "./external-approval-store.js";

const BODY_LIMIT = 4 * 1024;
const DecisionBody = z.object({ decision: z.enum(["approve", "decline"]) }).strict();

export interface CoreOwnerApprovalRouteOptions {
  store: CustomMcpExternalApprovalStore;
  listServers(userId: string): Promise<CustomMcpServer[]>;
  requireUser(context: Context, mutation?: boolean): Promise<string | Response>;
}

function unavailable(context: Context, error: unknown): Response {
  console.error("[core-mcp] owner approval failed:", error instanceof Error ? error.name : typeof error);
  return context.json({ error: "Matrix Core MCP approval unavailable" }, 503);
}

export function registerCoreOwnerApprovalRoutes(app: Hono, options: CoreOwnerApprovalRouteOptions): void {
  app.get("/core/external-approvals", async (context) => {
    context.header("Cache-Control", "no-store");
    const userId = await options.requireUser(context);
    if (typeof userId !== "string") return userId;
    try {
      const [pending, servers] = await Promise.all([
        options.store.listPendingExternalCustomMcpToolApprovals(userId), options.listServers(userId),
      ]);
      const slugs = assignCoreServiceSlugs(servers);
      // Arguments are never returned: the owner reviews tool identity, not upstream payloads.
      return context.json({ approvals: pending.map(entry => ({
        approvalId: entry.approvalId, service: slugs.get(entry.serverId) ?? null, tool: entry.toolName,
        createdAt: entry.createdAt.toISOString(), expiresAt: entry.expiresAt.toISOString(),
      })) });
    } catch (error: unknown) { return unavailable(context, error); }
  });

  app.post("/core/external-approvals/:approvalId", bodyLimit({ maxSize: BODY_LIMIT }), async (context) => {
    context.header("Cache-Control", "no-store");
    const userId = await options.requireUser(context, true);
    if (typeof userId !== "string") return userId;
    const approvalId = z.uuid().safeParse(context.req.param("approvalId"));
    let body: unknown;
    try { body = await context.req.json(); }
    catch (error: unknown) {
      if (error instanceof Error && error.name === "BodyLimitError") throw error;
      console.warn("[core-mcp] owner approval body parse failed:", error instanceof Error ? error.name : typeof error);
      return context.json({ error: "Invalid request body" }, 400);
    }
    const parsed = DecisionBody.safeParse(body);
    if (!approvalId.success || !parsed.success) return context.json({ error: "Invalid request body" }, 400);
    try {
      const decided = await options.store.decideExternalCustomMcpToolApproval({
        userId, approvalId: approvalId.data, decision: parsed.data.decision,
      });
      return decided ? context.json(decided) : context.json({ error: "Matrix Core MCP approval unavailable" }, 409);
    } catch (error: unknown) { return unavailable(context, error); }
  });
}
