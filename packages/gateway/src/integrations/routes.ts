import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { createHmac, timingSafeEqual } from "node:crypto";
import { listServices, getService, getAction } from "./registry.js";
import type { PipedreamConnectClient } from "./pipedream.js";
import type { PlatformDb } from "../platform-db.js";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ConnectBodySchema = z.object({
  service: z.string().min(1),
  label: z.string().optional(),
});

const CallBodySchema = z.looseObject({
  service: z.string().min(1),
  action: z.string().min(1),
  label: z.string().optional(),
});

const WebhookBodySchema = z.object({
  external_user_id: z.string().min(1),
  account_id: z.string().min(1),
  app: z.string().min(1),
  label: z.string().optional(),
  email: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// HMAC verification
// ---------------------------------------------------------------------------

function verifyHmac(payload: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) {
    timingSafeEqual(expBuf, expBuf);
    return false;
  }
  return timingSafeEqual(sigBuf, expBuf);
}

// ---------------------------------------------------------------------------
// UUID regex for param validation
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export interface IntegrationRoutesOpts {
  db: PlatformDb;
  pipedream: PipedreamConnectClient;
  webhookSecret: string;
  resolveUserId: (c: Context) => Promise<string | null>;
}

export function createIntegrationRoutes(opts: IntegrationRoutesOpts): Hono {
  const { db, pipedream, webhookSecret, resolveUserId } = opts;
  const app = new Hono();

  // -----------------------------------------------------------------------
  // Auth helper -- returns userId or sends 401
  // -----------------------------------------------------------------------

  async function requireUser(c: Context): Promise<string | null> {
    const uid = await resolveUserId(c);
    if (!uid) return null;
    return uid;
  }

  // -----------------------------------------------------------------------
  // Ownership helper -- returns the service or sends error
  // -----------------------------------------------------------------------

  async function requireOwnedService(c: Context, id: string, uid: string) {
    if (!UUID_RE.test(id)) return null;
    const svc = await db.getConnectedService(id);
    if (!svc) return null;
    if (svc.user_id !== uid) return "forbidden" as const;
    return svc;
  }

  // -----------------------------------------------------------------------
  // GET /available -- public, no auth
  // -----------------------------------------------------------------------

  app.get("/available", (c) => {
    return c.json(listServices());
  });

  // -----------------------------------------------------------------------
  // GET / -- list user's connected services
  // -----------------------------------------------------------------------

  app.get("/", async (c) => {
    const uid = await requireUser(c);
    if (!uid) return c.json({ error: "Unauthorized" }, 401);
    const services = await db.listConnectedServices(uid);
    return c.json(services);
  });

  // -----------------------------------------------------------------------
  // POST /connect -- initiate OAuth flow
  // -----------------------------------------------------------------------

  app.post("/connect", bodyLimit({ maxSize: 4096 }), async (c) => {
    const uid = await requireUser(c);
    if (!uid) return c.json({ error: "Unauthorized" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const parsed = ConnectBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }

    const { service, label } = parsed.data;
    const def = getService(service);
    if (!def) {
      return c.json({ error: `Unknown service: ${service}` }, 400);
    }

    const user = await db.getUserById(uid);
    const externalId = user?.pipedream_external_id ?? uid;

    const { token } = await pipedream.createConnectToken(externalId);
    const url = pipedream.getOAuthUrl(token, def.pipedreamApp);

    return c.json({ url, service });
  });

  // -----------------------------------------------------------------------
  // POST /webhook/connected -- Pipedream webhook (HMAC verified)
  // -----------------------------------------------------------------------

  app.post("/webhook/connected", bodyLimit({ maxSize: 65536 }), async (c) => {
    const rawBody = await c.req.text();

    const signature = c.req.header("x-pd-signature");
    if (!signature || !verifyHmac(rawBody, signature, webhookSecret)) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const parsed = WebhookBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid webhook payload" }, 400);
    }

    const { external_user_id, account_id, app: appName, label, email, scopes } = parsed.data;

    // Find user by pipedream_external_id
    const result = await db.raw(
      "SELECT id FROM users WHERE pipedream_external_id = $1 LIMIT 1",
      [external_user_id],
    );
    if (result.rows.length === 0) {
      return c.json({ error: "User not found" }, 404);
    }
    const webhookUserId = result.rows[0].id as string;

    await db.connectService({
      userId: webhookUserId,
      service: appName,
      pipedreamAccountId: account_id,
      accountLabel: label ?? appName,
      accountEmail: email,
      scopes: scopes ?? [],
    });

    return c.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // POST /call -- proxy API call through Pipedream
  // -----------------------------------------------------------------------

  app.post("/call", bodyLimit({ maxSize: 65536 }), async (c) => {
    const uid = await requireUser(c);
    if (!uid) return c.json({ error: "Unauthorized" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const parsed = CallBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }

    const { service, action, label } = parsed.data;
    const params = (body as Record<string, unknown>).params as Record<string, unknown> | undefined;

    const def = getService(service);
    if (!def) {
      return c.json({ error: `Unknown service: ${service}` }, 400);
    }

    const actionDef = getAction(service, action);
    if (!actionDef) {
      return c.json({ error: `Unknown action: ${action} for service ${service}` }, 400);
    }

    // Find the user's active connection for this service
    const connections = await db.listConnectedServices(uid);
    let connection = connections.find((s) => s.service === service);
    if (label) {
      connection = connections.find((s) => s.service === service && s.account_label === label) ?? connection;
    }
    if (!connection) {
      return c.json({ error: `Service ${service} is not connected` }, 404);
    }

    const user = await db.getUserById(uid);
    const externalId = user?.pipedream_external_id ?? uid;

    try {
      const data = await pipedream.callAction({
        externalUserId: externalId,
        accountId: connection.pipedream_account_id,
        url: `https://api.pipedream.com/v1/connect/${def.pipedreamApp}/${action}`,
        body: params ?? {},
      });

      await db.touchServiceUsage(connection.id);

      return c.json({ data, service, action });
    } catch (err: unknown) {
      if (err instanceof Error && (err as any).status === 429) {
        return c.json({ error: "Rate limited by provider. Please try again later." }, 429);
      }
      console.error(`[integrations] callAction error for ${service}/${action}:`, err);
      return c.json({ error: "Integration call failed" }, 502);
    }
  });

  // -----------------------------------------------------------------------
  // GET /:id/status -- check connection health
  // -----------------------------------------------------------------------

  app.get("/:id/status", async (c) => {
    const uid = await requireUser(c);
    if (!uid) return c.json({ error: "Unauthorized" }, 401);

    const id = c.req.param("id");
    const result = await requireOwnedService(c, id, uid);
    if (result === null) return c.json({ error: "Not found" }, 404);
    if (result === "forbidden") return c.json({ error: "Forbidden" }, 403);

    return c.json({
      id: result.id,
      service: result.service,
      status: result.status,
      account_label: result.account_label,
      connected_at: result.connected_at,
      last_used_at: result.last_used_at,
    });
  });

  // -----------------------------------------------------------------------
  // DELETE /:id -- disconnect service
  // -----------------------------------------------------------------------

  app.delete("/:id", async (c) => {
    const uid = await requireUser(c);
    if (!uid) return c.json({ error: "Unauthorized" }, 401);

    const id = c.req.param("id");
    const result = await requireOwnedService(c, id, uid);
    if (result === null) return c.json({ error: "Not found" }, 404);
    if (result === "forbidden") return c.json({ error: "Forbidden" }, 403);

    try {
      await pipedream.revokeAccount(result.pipedream_account_id);
    } catch (err: unknown) {
      console.error("[integrations] revokeAccount error:", err);
    }

    await db.disconnectService(id);

    return c.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // POST /:id/refresh -- force token refresh
  // -----------------------------------------------------------------------

  app.post("/:id/refresh", async (c) => {
    const uid = await requireUser(c);
    if (!uid) return c.json({ error: "Unauthorized" }, 401);

    const id = c.req.param("id");
    const result = await requireOwnedService(c, id, uid);
    if (result === null) return c.json({ error: "Not found" }, 404);
    if (result === "forbidden") return c.json({ error: "Forbidden" }, 403);

    // Pipedream handles token refresh automatically.
    // We update status to active in case it was marked expired.
    await db.updateServiceStatus(id, "active");

    return c.json({ id, status: "active", service: result.service });
  });

  return app;
}
