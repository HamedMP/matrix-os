import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import type { PlatformDb } from "../platform-db.js";
import type { PipedreamConnectClient } from "./pipedream.js";
import { JevReadBindingSchema } from "./jev-bound-read.js";
import { executeJevBoundLabels, JevLabelInput } from "./jev-bound-labels.js";
import { resolveIntegrationConnection } from "./connection-selection.js";
import { INTEGRATION_READ_SCOPE_HEADER } from "./scope-provenance.js";
import { boundedOperation } from "../bounded-operation.js";

const Body = z.strictObject({ binding: JevReadBindingSchema, input: JevLabelInput });
export function createJevLabelCallRoutes(options: { db: PlatformDb; pipedream: PipedreamConnectClient;
  resolveUserId: (c: Context) => Promise<string | null> }) {
  const app = new Hono();
  app.post("/jev-label-call", bodyLimit({ maxSize: 16 * 1024 }), async c => {
    const ownerId = await options.resolveUserId(c);
    if (!ownerId) return c.json({ error: "Unauthorized" }, 401);
    if (c.req.header(INTEGRATION_READ_SCOPE_HEADER) === "read") return c.json({ error: "Action not permitted" }, 403);
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
        signal.throwIfAborted();
        return executeJevBoundLabels({ ownerId, externalUserId: user.pipedream_external_id, connection: selected.connection,
          binding: parsed.data.binding, input: parsed.data.input, pipedream: options.pipedream, signal });
      }, 45_000, c.req.raw.signal);
      return c.json(data);
    } catch (error) {
      console.warn("[jev-labels] Labeling unconfirmed", { errorName: error instanceof Error ? error.name : "UnknownError" });
      return c.json({ error: "Mailbox labeling could not be confirmed" }, 503);
    }
  });
  return app;
}
