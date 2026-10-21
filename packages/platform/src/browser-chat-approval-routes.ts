import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { BrowserDecisionTupleSchema, BrowserGrantRevokeTupleSchema } from "@matrix-os/contracts";
import { BROWSER_APPROVAL_PROOF_HEADER, verifyBrowserDecisionProof, verifyBrowserRevokeProof } from "./browser-chat-approval-proof.js";
import { buildPlatformVerificationToken, timingSafeTokenEquals } from "./platform-token.js";
import { BrowserApprovalMachineLookup } from "./browser-approval-machine-lookup.js";
const HandleSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const RequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("decision"), tuple: BrowserDecisionTupleSchema }),
  z.strictObject({ kind: z.literal("revoke"), tuple: BrowserGrantRevokeTupleSchema }),
]);
/** Machine transport may ask only for verification; it cannot issue owner consent. */
export function createBrowserChatApprovalRoutes(options: { enabled: boolean; platformSecret: string; lookup?: BrowserApprovalMachineLookup }) {
  const app = new Hono();
  let active = 0; // fixed cap, decremented in finally; no identity registry.
  app.post("/internal/containers/:handle/browser-approvals/verify", bodyLimit({ maxSize: 4000 }), async c => {
    if (!options.enabled) return c.json({ error: "Not found" }, 404);
    const parsedHandle = HandleSchema.safeParse(c.req.param("handle"));
    if (!parsedHandle.success) return c.json({ error: "Invalid request" }, 400);
    const handle = parsedHandle.data;
    if (!options.platformSecret || !(options.lookup instanceof BrowserApprovalMachineLookup)) return c.json({ error: "Unavailable" }, 503);
    if (!timingSafeTokenEquals(c.req.header("authorization"), `Bearer ${buildPlatformVerificationToken(handle, options.platformSecret)}`)) return c.json({ error: "Unauthorized" }, 401);
    if (active >= 8) return c.json({ error: "Unavailable" }, 503);
    active++;
    try {
      let value: unknown;
      try { value = await c.req.json(); } catch (error: unknown) {
        if (error instanceof SyntaxError) return c.json({ error: "Invalid request" }, 400);
        throw error;
      }
      const parsed = RequestSchema.safeParse(value);
      if (!parsed.success || parsed.data.tuple.handle !== handle) return c.json({ error: "Invalid request" }, 400);
      const { tuple } = parsed.data;
      const proof = c.req.header(BROWSER_APPROVAL_PROOF_HEADER);
      const verified = parsed.data.kind === "decision" ? verifyBrowserDecisionProof(proof, parsed.data.tuple, options.platformSecret)
        : verifyBrowserRevokeProof(proof, parsed.data.tuple, options.platformSecret);
      if (!verified) return c.json({ error: "Approval unavailable" }, 403);
      const machine = await options.lookup.resolveMachine(handle, tuple.runtimeSlot);
      if (!machine || machine.status !== "running" || machine.clerkUserId !== tuple.actorId || machine.runtimeSlot !== tuple.runtimeSlot) return c.json({ error: "Approval unavailable" }, 403);
      return c.json({ verified }, 200, { "Cache-Control": "no-store" });
    } catch (error: unknown) {
      console.warn("[browser-approval] Verification unavailable", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Approval unavailable" }, 503);
    } finally { active--; }
  });
  return app;
}
