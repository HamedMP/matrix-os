import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { PlatformDb } from "../platform-db.js";
import type { PipedreamConnectClient } from "./pipedream.js";
import { JevReadBindingSchema } from "./jev-bound-read.js";
import { JevLabelOperation, JevMessageLabels } from "./jev-bound-labels.js";
import { resolveIntegrationConnection } from "./connection-selection.js";
import { INTEGRATION_READ_SCOPE_HEADER } from "./scope-provenance.js";
import { boundedOperation } from "../bounded-operation.js";
import { executeJevBoundRead } from "./jev-bound-read.js";

/** Only Platform's verified machine/owner guard sets these context values. */
export async function authorizeInternalJevLabels(c: Context): Promise<boolean> {
  return c.get("internalSignedOwnerDelegation") === true
    && Boolean(c.get("internalContainerHandle") && c.get("internalContainerClerkUserId"));
}

const Body = z.strictObject({ binding: JevReadBindingSchema, operation: JevLabelOperation });
export function createJevLabelCallRoutes(options: { db: PlatformDb; pipedream: PipedreamConnectClient;
  resolveUserId: (c: Context) => Promise<string | null>; authorizeInternal?: (c: Context) => Promise<boolean> }) {
  const app = new Hono();
  app.post("/jev-label-call", bodyLimit({ maxSize: 16 * 1024 }), async c => {
    const ownerId = await options.resolveUserId(c);
    if (!ownerId) return c.json({ error: "Unauthorized" }, 401);
    if (c.req.header(INTEGRATION_READ_SCOPE_HEADER) === "read") return c.json({ error: "Action not permitted" }, 403);
    // Only the verified internal machine delegation mount may use this seam.
    // Owner HTTP bodies and model bearer tokens never grant labeling authority.
    if (!options.authorizeInternal || !await options.authorizeInternal(c)) return c.json({ error: "Action not permitted" }, 403);
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) return c.json({ error: "Invalid request" }, 415);
    let raw: unknown;
    try { raw = await c.req.json(); }
    catch (error) {
      if (error instanceof Error && error.name === "BodyLimitError") return c.json({ error: "Request too large" }, 413);
      console.warn("[jev-labels] Invalid request", { errorName: error instanceof Error ? error.name : "UnknownError" });
      return c.json({ error: "Invalid request" }, 400);
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    if (parsed.data.binding.labelingEnabled !== true) return c.json({ error: "Action not permitted" }, 403);
    try {
      const data = await boundedOperation(async signal => {
        const selected = resolveIntegrationConnection(await options.db.listConnectedServices(ownerId), "gmail", parsed.data.binding.accountLabel);
        if (selected.kind !== "found") throw new Error("Bound account unavailable");
        const user = await options.db.getUserById(ownerId);
        if (!user?.pipedream_external_id) throw new Error("Owner unavailable");
        const externalUserId = user.pipedream_external_id;
        signal.throwIfAborted();
        const verify = async () => { await executeJevBoundRead({ ownerId, externalUserId,
          connection: selected.connection, binding: parsed.data.binding, action: "get_profile", pipedream: options.pipedream, signal }); };
        await verify();
        const call = options.pipedream.boundedGmailLabels;
        if (!call) throw new Error("Labeling unavailable");
        const identity = { externalUserId, accountId: selected.connection.pipedream_account_id };
        const operation = parsed.data.operation;
        if (operation.kind === "add-labels") {
          const before = JevMessageLabels.parse(await call({ ...identity, kind: "message-labels", messageId: operation.messageId }, signal));
          if (before.id !== operation.messageId || before.threadId !== operation.threadId) throw new Error("Bound message unavailable");
          await verify();
          return call({ ...identity, kind: "add-labels", messageId: operation.messageId, labelIds: operation.labelIds }, signal);
        }
        // One operation per request; revocation is checked by the owning Gateway
        // before each subsequent dispatch, never after a remote multi-write loop.
        return call({ ...identity, ...operation }, signal);
      }, 45_000, c.req.raw.signal);
      return c.json(data);
    } catch (error) {
      console.warn("[jev-labels] Labeling unconfirmed", { errorName: error instanceof Error ? error.name : "UnknownError" });
      return c.json({ error: "Mailbox labeling could not be confirmed" }, 503);
    }
  });
  return app;
}
