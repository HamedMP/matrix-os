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

const CallBodySchema = z.object({
  service: z.string().min(1),
  action: z.string().min(1),
  label: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
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
  if (!secret) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  // timingSafeEqual requires equal-length buffers. Copy the (untrusted)
  // signature into a zero-filled buffer sized to the expected digest so the
  // comparison runs in constant time regardless of input length. A shorter
  // signature leaves trailing zero bytes that won't match the hex digest; a
  // longer signature is silently truncated and still won't match unless the
  // first 64 bytes are the correct digest -- in which case the attacker
  // already knows the answer. The previous explicit length check leaked a
  // small amount of timing information about the input length.
  const expectedBuf = Buffer.from(expected);
  const sigBuf = Buffer.alloc(expectedBuf.length);
  Buffer.from(signature).copy(sigBuf, 0, 0, expectedBuf.length);
  return timingSafeEqual(sigBuf, expectedBuf);
}

// ---------------------------------------------------------------------------
// Per-action param validation
// ---------------------------------------------------------------------------

export function validateActionParams(
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

// Strip control characters and truncate to a safe length before logging
// untrusted input. Prevents log injection (CR/LF, ANSI escape) from external
// payloads like webhook bodies.
function safeForLog(value: unknown, maxLen = 64): string {
  return String(value).replace(/[\r\n\x00-\x1f\x7f]/g, "?").slice(0, maxLen);
}

// Pipedream SDK throws PipedreamError { statusCode, rawResponse }, but other
// callers (and our tests) historically used { status, headers }. Read both
// shapes so this code works against the real SDK and against legacy mocks.
export function getErrorStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { statusCode?: number; status?: number; rawResponse?: { status?: number } };
  return e.statusCode ?? e.status ?? e.rawResponse?.status;
}

export function getRetryAfterSeconds(err: unknown, fallback = 60): number {
  if (!err || typeof err !== "object") return fallback;
  const e = err as {
    headers?: Record<string, string> | { get?: (k: string) => string | null };
    rawResponse?: { headers?: { get?: (k: string) => string | null } };
  };
  // Web Headers (rawResponse.headers) uses .get(); plain object uses indexing.
  let raw: string | null | undefined;
  if (e.rawResponse?.headers?.get) {
    raw = e.rawResponse.headers.get("retry-after");
  } else if (e.headers && typeof (e.headers as { get?: unknown }).get === "function") {
    raw = (e.headers as { get: (k: string) => string | null }).get("retry-after");
  } else if (e.headers && typeof e.headers === "object") {
    raw = (e.headers as Record<string, string>)["retry-after"];
  }
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ---------------------------------------------------------------------------
// Profile email resolution -- call each service's own API to get the email
// ---------------------------------------------------------------------------

const PROFILE_ENDPOINTS: Record<string, {
  url: string;
  extract: (data: any) => string | undefined;
}> = {
  gmail: {
    url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    extract: (d) => d?.emailAddress,
  },
  google_calendar: {
    url: "https://www.googleapis.com/oauth2/v1/userinfo",
    extract: (d) => d?.email,
  },
  google_drive: {
    url: "https://www.googleapis.com/oauth2/v1/userinfo",
    extract: (d) => d?.email,
  },
  github: {
    url: "https://api.github.com/user",
    // GitHub /user.email is null unless the user has a public email; don't
    // fall back to .login because it's a username, not an email, and writing
    // it into account_email is misleading. Returning undefined leaves the
    // column empty -- that's accurate. (Future: call /user/emails and pick
    // the verified primary if we want fuller coverage.)
    extract: (d) => d?.email ?? undefined,
  },
  slack: {
    url: "https://slack.com/api/auth.test",
    extract: (d) => d?.user,
  },
  discord: {
    url: "https://discord.com/api/v10/users/@me",
    extract: (d) => d?.email ?? d?.username,
  },
};

async function resolveAccountEmail(
  pipedream: PipedreamConnectClient,
  externalUserId: string,
  accountId: string,
  service: string,
): Promise<string | undefined> {
  const endpoint = PROFILE_ENDPOINTS[service];
  if (!endpoint) return undefined;
  try {
    const result = await pipedream.proxyGet({
      externalUserId,
      accountId,
      url: endpoint.url,
    });
    return endpoint.extract(result);
  } catch (err) {
    console.warn(`[integrations] resolveAccountEmail failed for ${service}:`, err instanceof Error ? err.message : err);
    return undefined;
  }
}

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

  // Pending labels from /connect that need to survive the OAuth round-trip.
  // Keyed by "externalUserId:appSlug", TTL 10 minutes, capped at 1000 entries.
  const pendingLabels = new Map<string, { label: string; ts: number }>();
  const LABEL_TTL_MS = 10 * 60 * 1000;
  const PENDING_MAX = 1000;
  const pendingLabelCleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pendingLabels) {
      if (now - v.ts > LABEL_TTL_MS) pendingLabels.delete(k);
    }
  }, 5 * 60 * 1000);
  pendingLabelCleanup.unref();

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
    if (!UUID_RE.test(id)) return "invalid" as const;
    const svc = await db.getConnectedService(id);
    if (!svc) return null;
    if (svc.user_id !== uid) return "forbidden" as const;
    return svc;
  }

  // -----------------------------------------------------------------------
  // GET /available -- public, no auth. Enriches registry with Pipedream logos.
  // -----------------------------------------------------------------------

  const logoCache = new Map<string, string>();
  const LOGO_CACHE_MAX = 200;
  let logosPromise: Promise<void> | null = null;

  function loadLogos(): Promise<void> {
    if (logosPromise) return logosPromise;
    // The IIFE flips this to true when *every* fetch fails, signaling the
    // outer scope to drop the memoized promise so a later call can retry.
    let allFailed = false;
    const promise = (async () => {
      const services = listServices();
      const results = await Promise.allSettled(
        services.map(async (s) => {
          const info = await pipedream.getAppInfo(s.pipedreamApp);
          if (info?.imgSrc) {
            if (logoCache.size >= LOGO_CACHE_MAX) logoCache.delete(logoCache.keys().next().value!);
            logoCache.set(s.id, info.imgSrc);
          }
        }),
      );
      for (const r of results) {
        if (r.status === "rejected") {
          console.error("[integrations] Logo fetch failed:", r.reason);
        }
      }
      if (results.length > 0 && results.every((r) => r.status === "rejected")) {
        allFailed = true;
      }
    })();
    logosPromise = promise;
    // Clear the memoized promise on total failure (Pipedream down at
    // startup). Identity guard so a stale closure can't clobber a newer
    // in-flight retry that already started.
    promise.then(() => {
      if (allFailed && logosPromise === promise) logosPromise = null;
    });
    return promise;
  }
  // Best-effort startup warm; the IIFE swallows individual errors via
  // Promise.allSettled, so this can't reject -- but attach .catch defensively
  // to satisfy lint and avoid any unhandled-rejection surprises.
  loadLogos().catch(() => {});

  app.get("/available", (c) => {
    const services = listServices().map((s) => ({
      ...s,
      logoUrl: logoCache.get(s.id) || s.logoUrl,
    }));
    return c.json(services);
  });

  // -----------------------------------------------------------------------
  // GET / -- list user's connected services
  // -----------------------------------------------------------------------

  app.get("/", async (c) => {
    const uid = await requireUser(c);
    if (!uid) return c.json({ error: "Unauthorized" }, 401);
    const services = await db.listConnectedServices(uid);
    return c.json(services.map(({ id, service, account_label, account_email, scopes, status, connected_at, last_used_at }) => ({
      id, service, account_label, account_email, scopes, status, connected_at, last_used_at,
    })));
  });

  // -----------------------------------------------------------------------
  // POST /sync -- sync connected accounts from Pipedream to platform DB
  // Used when webhooks can't reach the gateway (e.g. local dev)
  // -----------------------------------------------------------------------

  app.post("/sync", bodyLimit({ maxSize: 4096 }), async (c) => {
    const uid = await requireUser(c);
    if (!uid) return c.json({ error: "Unauthorized" }, 401);

    const user = await db.getUserById(uid);
    const externalId = user?.pipedream_external_id ?? uid;

    try {
      const pdAccounts = await pipedream.listAccounts(externalId);
      const existing = await db.listConnectedServices(uid);
      const existingPdIds = new Set(existing.map((s) => s.pipedream_account_id));

      const newAccounts = pdAccounts.filter((acc) => !existingPdIds.has(acc.id) && getService(acc.app));

      // Resolve emails for new accounts missing them
      const resolvedEmails = await Promise.all(
        newAccounts.map(async (acc) => {
          if (acc.email) return acc.email;
          return resolveAccountEmail(pipedream, externalId, acc.id, acc.app);
        }),
      );

      await Promise.all(
        newAccounts.map((acc, i) =>
          db.connectService({
            userId: uid,
            service: acc.app,
            pipedreamAccountId: acc.id,
            accountLabel: acc.app,
            accountEmail: resolvedEmails[i],
            scopes: [],
          }),
        ),
      );
      for (const acc of newAccounts) {
        emit({ type: "integration:connected", service: acc.app, accountLabel: acc.app });
      }
      const synced = newAccounts.length;

      // Also backfill emails for existing connections missing them
      const missingEmail = existing.filter((s) => !s.account_email);
      await Promise.all(
        missingEmail.map(async (s) => {
          const conn = pdAccounts.find((a) => a.id === s.pipedream_account_id);
          if (!conn) return;
          const email = await resolveAccountEmail(pipedream, externalId, conn.id, s.service);
          if (email) await db.updateAccountEmail(s.id, email);
        }),
      );

      const services = await db.listConnectedServices(uid);
      return c.json({ synced, services });
    } catch (err) {
      console.error("[integrations] Sync failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "Failed to sync accounts" }, 502);
    }
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

    let connectLinkUrl: string;
    try {
      ({ connectLinkUrl } = await pipedream.createConnectToken(externalId));
    } catch (err) {
      console.error("[integrations] createConnectToken error:", err instanceof Error ? err.message : err);
      return c.json({ error: "Failed to initiate connection. Please try again." }, 502);
    }
    const url = pipedream.getOAuthUrl(connectLinkUrl, def.pipedreamApp);

    if (label) {
      if (pendingLabels.size >= PENDING_MAX) {
        const oldest = [...pendingLabels.entries()].reduce((a, b) => a[1].ts < b[1].ts ? a : b);
        pendingLabels.delete(oldest[0]);
      }
      pendingLabels.set(`${externalId}:${def.pipedreamApp}`, { label, ts: Date.now() });
    }

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

    if (!getService(appName)) {
      return c.json({ error: "Unsupported app" }, 400);
    }

    const webhookUser = await db.getUserByPipedreamExternalId(external_user_id);
    if (!webhookUser) {
      console.warn("[integrations] Webhook for unknown external_user_id:", safeForLog(external_user_id));
      return c.json({ error: "Unknown user" }, 400);
    }
    const webhookUserId = webhookUser.id;

    // Recover the user-entered label from /connect (Pipedream doesn't relay it)
    const pendingKey = `${external_user_id}:${appName}`;
    const pending = pendingLabels.get(pendingKey);
    const resolvedLabel = pending && (Date.now() - pending.ts < LABEL_TTL_MS)
      ? pending.label
      : (label ?? appName);
    pendingLabels.delete(pendingKey);

    let resolvedEmail = email;
    if (!resolvedEmail) {
      resolvedEmail = await resolveAccountEmail(pipedream, external_user_id, account_id, appName);
    }

    try {
      await db.connectService({
        userId: webhookUserId,
        service: appName,
        pipedreamAccountId: account_id,
        accountLabel: resolvedLabel,
        accountEmail: resolvedEmail,
        scopes: scopes ?? [],
      });
    } catch (err) {
      console.error("[integrations] webhook connectService failed:", err instanceof Error ? err.message : err);
      return c.json({ error: "Internal error" }, 500);
    }

    emit({ type: "integration:connected", service: appName, accountLabel: resolvedLabel });

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

    const { service, action, label, params } = parsed.data;

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
    let connection;
    if (label) {
      connection = connections.find((s) => s.service === service && s.account_label === label);
      if (!connection) {
        const available = connections
          .filter((s) => s.service === service)
          .map((s) => s.account_label);
        return c.json({
          error: `No ${service} account with label "${label}"`,
          available_labels: available.length > 0 ? available : undefined,
          connect_hint: available.length === 0
            ? `Use POST /api/integrations/connect with { "service": "${service}" } to connect it first.`
            : undefined,
        }, available.length > 0 ? 400 : 404);
      }
    } else {
      connection = connections.find((s) => s.service === service);
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
      let data: unknown;
      let summary: string | undefined;

      if (actionDef.componentKey) {
        const safeParams = Object.fromEntries(
          Object.entries(params ?? {}).filter(([k]) => k !== def.pipedreamApp),
        );
        const configuredProps: Record<string, unknown> = {
          ...safeParams,
          [def.pipedreamApp]: { authProvisionId: connection.pipedream_account_id },
        };
        const result = await pipedream.runAction({
          externalUserId: externalId,
          componentKey: actionDef.componentKey,
          configuredProps,
        });
        data = result.ret;
        const exports = result.exports as Record<string, unknown> | undefined;
        summary = typeof exports?.$summary === "string" ? exports.$summary : undefined;
      } else if (actionDef.directApi) {
        const api = actionDef.directApi;
        const url = typeof api.url === "function" ? api.url(params ?? {}) : api.url;
        if (api.method === "GET") {
          const queryParams = api.mapParams ? api.mapParams(params ?? {}) : undefined;
          data = await pipedream.proxyGet({
            externalUserId: externalId,
            accountId: connection.pipedream_account_id,
            url,
            params: queryParams,
          });
        } else {
          const body = api.mapBody ? api.mapBody(params ?? {}) : (params ?? {});
          data = await pipedream.proxyPost({
            externalUserId: externalId,
            accountId: connection.pipedream_account_id,
            url,
            body,
          });
        }
      } else {
        data = await pipedream.callAction({
          externalUserId: externalId,
          accountId: connection.pipedream_account_id,
          url: `https://api.pipedream.com/v1/connect/${def.pipedreamApp}/${action}`,
          body: params ?? {},
        });
      }

      await db.touchServiceUsage(connection.id);

      return c.json({ data, service, action, ...(summary ? { summary } : {}) });
    } catch (err: unknown) {
      if (getErrorStatusCode(err) === 429) {
        const retryAfter = getRetryAfterSeconds(err);
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
    if (result === "invalid") return c.json({ error: "Invalid ID" }, 400);
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
    if (result === "invalid") return c.json({ error: "Invalid ID" }, 400);
    if (result === null) return c.json({ error: "Not found" }, 404);
    if (result === "forbidden") return c.json({ error: "Forbidden" }, 403);

    try {
      await pipedream.revokeAccount(result.pipedream_account_id);
    } catch (err: unknown) {
      // If the account is already gone at Pipedream (404), proceed to mark
      // the local row as revoked. Otherwise, fail loudly so the credential
      // doesn't dangle: the local row stays active and the user can retry.
      const status = getErrorStatusCode(err);
      if (status !== 404) {
        console.error("[integrations] revokeAccount error:", err);
        return c.json({ error: "Failed to revoke with provider" }, 502);
      }
      console.warn("[integrations] revokeAccount 404 -- already gone at provider, continuing");
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
    if (result === "invalid") return c.json({ error: "Invalid ID" }, 400);
    if (result === null) return c.json({ error: "Not found" }, 404);
    if (result === "forbidden") return c.json({ error: "Forbidden" }, 403);
    if (result.status === "revoked") return c.json({ error: "Not found" }, 404);

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
