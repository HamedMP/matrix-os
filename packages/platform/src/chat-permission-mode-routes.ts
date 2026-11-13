import { CanonicalSetChatPermissionModeRequestSchema } from "@matrix-os/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { CHAT_PERMISSION_MODE_PROOF_HEADER, verifyChatPermissionModeProof } from "./chat-permission-mode-proof.js";

const ref = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
/** Always mounted behind the existing exact-machine/owner guard; no optional provider dependency. */
export function createChatPermissionModeVerificationRoutes(platformSecret: string) {
  const app = new Hono<{ Variables: { internalContainerHandle: string; internalContainerClerkUserId: string } }>();
  app.post("/permission-mode/verify", bodyLimit({ maxSize: 4000 }), async c => {
    const handle = c.get("internalContainerHandle"), actorId = c.get("internalContainerClerkUserId");
    if (!handle || !actorId || !platformSecret) return c.json({ error: "Unauthorized" }, 401);
    let value: unknown;
    try { value = await c.req.json(); } catch (error: unknown) {
      console.warn("[chat-permission] Invalid body", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "Invalid request" }, 400);
    }
    const parsed = CanonicalSetChatPermissionModeRequestSchema.extend({ chatId: ref, runId: ref }).safeParse(value);
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    return verifyChatPermissionModeProof(c.req.header(CHAT_PERMISSION_MODE_PROOF_HEADER), { ...parsed.data, handle, actorId, secret: platformSecret })
      ? c.json({ verified: true }) : c.json({ error: "Permission change unavailable" }, 403);
  });
  return app;
}
