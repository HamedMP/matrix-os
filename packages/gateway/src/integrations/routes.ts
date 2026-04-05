import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { createHmac, timingSafeEqual } from "node:crypto";
import { listServices, getService, getAction } from "./registry.js";
import type { ServiceAction } from "./types.js";
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
// Per-action param validation
// ---------------------------------------------------------------------------

function validateActionParams(
  actionDef: ServiceAction,
  params: Record<string, unknown> | undefined,
): { valid: true } | { valid: false; missing: string[]; typeErrors: string[] } {
  const missing: string[] = [];
  const typeErrors: string[] = [];

  for (const [name, def] of Object.entries(actionDef.params)) {
    const value = params?.[name];
    if (def.required && (value === undefined || value === null)) {
      missing.push(name);
      continue;
    }
    if (value !== undefined && value !== null) {
      const expectedType = def.type;
      const actualType = typeof value;
      if (expectedType === "string" && actualType !== "string") {
        typeErrors.push(`${name}: expected string, got ${actualType}`);
      } else if (expectedType === "number" && actualType !== "number") {
        typeErrors.push(`${name}: expected number, got ${actualType}`);
      } else if (expectedType === "boolean" && actualType !== "boolean") {
        typeErrors.push(`${name}: expected boolean, got ${actualType}`);
      } else if (expectedType === "object" && (actualType !== "object" || Array.isArray(value))) {
        typeErrors.push(`${name}: expected object, got ${actualType}`);
      }
    }
  }

  if (missing.length > 0 || typeErrors.length > 0) {
    return { valid: false, missing, typeErrors };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Connection error classification
// ---------------------------------------------------------------------------

function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("enetunreach");
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.name === "TimeoutError" || err.message.includes("timed out");
}

// ---------------------------------------------------------------------------
// UUID regex for param validation
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export interface IntegrationBroadcast {
  (msg: { type: "integration:connected"; service: string; accountLabel: string }): void;
  (msg: { type: "integration:disconnected"; service: string; id: string }): void;
  (msg: { type: "integration:expired"; service: string; id: string; accountLabel: string }): void;
}

export interface IntegrationRoutesOpts {
  db: PlatformDb;
  pipedream: PipedreamConnectClient;
  webhookSecret: string;
  resolveUserId: (c: Context) => Promise<string | null>;
  broadcast?: IntegrationBroadcast;
}

export function createIntegrationRoutes(opts: IntegrationRoutesOpts): Hono {
  const { db, pipedream, webhookSecret, resolveUserId, broadcast } = opts;
  const emit = broadcast ?? (() => {});
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

    const { connectLinkUrl } = await pipedream.createConnectToken(externalId);
    const url = pipedream.getOAuthUrl(connectLinkUrl, def.pipedreamApp);

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

    emit({ type: "integration:connected", service: appName, accountLabel: label ?? appName });

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

    // Validate action params against the registry definition
    const paramValidation = validateActionParams(actionDef, params);
    if (!paramValidation.valid) {
      const parts: string[] = [];
      if (paramValidation.missing.length > 0) {
        parts.push(`Missing required params: ${paramValidation.missing.join(", ")}`);
      }
      if (paramValidation.typeErrors.length > 0) {
        parts.push(`Invalid param type: ${paramValidation.typeErrors.join("; ")}`);
      }
      return c.json({
        error: parts.join(". "),
        missing: paramValidation.missing.length > 0 ? paramValidation.missing : undefined,
        type_errors: paramValidation.typeErrors.length > 0 ? paramValidation.typeErrors : undefined,
      }, 400);
    }

    // Find the user's active connection for this service
    const connections = await db.listConnectedServices(uid);
    let connection = connections.find((s) => s.service === service);
    if (label) {
      connection = connections.find((s) => s.service === service && s.account_label === label) ?? connection;
    }
    if (!connection) {
      return c.json({
        error: `Service ${service} is not connected`,
        connect_hint: `Use POST /api/integrations/connect with { "service": "${service}" } to connect it first.`,
      }, 404);
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
        const retryAfterRaw = (err as any).headers?.["retry-after"];
        const retryAfter = retryAfterRaw ? parseInt(retryAfterRaw, 10) : 60;
        return c.json(
          { error: "Rate limited by provider. Please try again later.", retry_after: retryAfter },
          { status: 429, headers: { "Retry-After": String(retryAfter) } },
        );
      }
      if (isTimeoutError(err)) {
        console.error(`[integrations] callAction timeout for ${service}/${action}`);
        return c.json({ error: "Integration call timed out" }, 504);
      }
      if (isConnectionError(err)) {
        console.error(`[integrations] callAction connection error for ${service}/${action}:`, err);
        return c.json({ error: "Integration service unavailable" }, 503);
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

    emit({ type: "integration:disconnected", service: result.service, id });

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

  // -----------------------------------------------------------------------
  // User Apps -- CRUD + integration manifest validation
  // -----------------------------------------------------------------------

  const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

  const CreateAppBodySchema = z.object({
    name: z.string().min(1).max(100),
    slug: z.string().regex(SAFE_SLUG, "Slug must be lowercase alphanumeric with hyphens"),
    description: z.string().max(500).optional(),
    integrations: z.object({
      required: z.array(z.string()).optional(),
      optional: z.array(z.string()).optional(),
    }).optional(),
  });

  app.get("/apps", async (c) => {
    const uid = await requireUser(c);
    if (!uid) return c.json({ error: "Unauthorized" }, 401);

    const apps = await db.listUserApps(uid);
    return c.json(apps);
  });

  app.get("/apps/:appId", async (c) => {
    const uid = await requireUser(c);
    if (!uid) return c.json({ error: "Unauthorized" }, 401);

    const appId = c.req.param("appId");
    if (!UUID_RE.test(appId)) return c.json({ error: "Invalid app ID" }, 400);

    const userApp = await db.getUserApp(appId);
    if (!userApp) return c.json({ error: "Not found" }, 404);
    if (userApp.user_id !== uid) return c.json({ error: "Forbidden" }, 403);

    // Enrich with integration status
    const connections = await db.listConnectedServices(uid);
    const connectedIds = new Set(connections.map((c) => c.service));
    const required = userApp.services_used;
    const missing = required.filter((s) => !connectedIds.has(s));

    return c.json({
      ...userApp,
      integration_status: {
        connected: required.filter((s) => connectedIds.has(s)),
        missing,
        ready: missing.length === 0,
      },
    });
  });

  app.post("/apps", bodyLimit({ maxSize: 8192 }), async (c) => {
    const uid = await requireUser(c);
    if (!uid) return c.json({ error: "Unauthorized" }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const parsed = CreateAppBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }

    const { name, slug, description, integrations } = parsed.data;

    // Validate integration manifest against service registry
    const allServices = new Set([
      ...(integrations?.required ?? []),
      ...(integrations?.optional ?? []),
    ]);
    const unknownServices: string[] = [];
    for (const svcId of allServices) {
      if (!getService(svcId)) {
        unknownServices.push(svcId);
      }
    }
    if (unknownServices.length > 0) {
      return c.json({
        error: "Unknown services in integration manifest",
        unknown_services: unknownServices,
        available: listServices().map((s) => s.id),
      }, 400);
    }

    // services_used = required services (the ones the app depends on)
    const servicesUsed = integrations?.required ?? [];

    const userApp = await db.createUserApp({
      userId: uid,
      name,
      slug,
      description,
      servicesUsed,
    });

    // Check which required services are already connected
    const connections = await db.listConnectedServices(uid);
    const connectedIds = new Set(connections.map((c) => c.service));
    const missing = servicesUsed.filter((s) => !connectedIds.has(s));

    return c.json({
      ...userApp,
      integration_status: {
        connected: servicesUsed.filter((s) => connectedIds.has(s)),
        missing,
        ready: missing.length === 0,
      },
    }, 201);
  });

  return app;
}
