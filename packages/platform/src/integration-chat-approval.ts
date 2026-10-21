import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { CUSTOM_MCP_APPROVAL_PROOF_HEADER, verifyCustomMcpApprovalProof } from "./custom-mcp-approval-proof.js";

const ref = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const Decision = z.strictObject({ chatId: ref, runId: ref, approvalId: ref, clientRequestId: ref,
  decision: z.enum(["approve", "decline", "cancel"]) });

/** Mount inside the existing machine-authenticated, Preview-denying integration boundary. */
export function createIntegrationChatApprovalRoutes(platformSecret: string) {
  const app = new Hono<{ Variables: { internalContainerHandle: string; internalContainerClerkUserId: string } }>();
  app.post("/approval/verify", bodyLimit({ maxSize: 4000 }), async c => {
    const handle = c.get("internalContainerHandle");
    const actorId = c.get("internalContainerClerkUserId");
    if (!handle || !actorId || !platformSecret) return c.json({ error: "Unauthorized" }, 401);
    let value: unknown;
    try { value = await c.req.json(); }
    catch (error: unknown) {
      console.warn("[chat-integrations] Invalid approval body", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Invalid request" }, 400);
    }
    const parsed = Decision.safeParse(value);
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    const verified = verifyCustomMcpApprovalProof(c.req.header(CUSTOM_MCP_APPROVAL_PROOF_HEADER), {
      ...parsed.data, handle, actorId, secret: platformSecret,
    });
    return verified ? c.json({ verified: true }) : c.json({ error: "Approval unavailable" }, 403);
  });
  return app;
}
