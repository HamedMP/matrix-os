/**
 * Gateway proxy for the Hermes dashboard API (Spec 101, Task 1).
 *
 * Security constraints:
 * - Every route requires a valid matrix request principal.
 * - Upstream is a fixed loopback address from HERMES_DASHBOARD_URL; never
 *   user-controlled.  Validate at startup that the URL resolves to loopback.
 * - bodyLimit on every mutating route (incl. DELETE).
 * - AbortSignal.timeout(10_000) on every upstream fetch.
 * - redirect: "error" on every upstream fetch.
 * - Raw upstream/provider error bodies are never forwarded; generic messages
 *   only.  Log real errors server-side.
 * - :id validated against SAFE_SLUG; :pairingId shape validated separately.
 * - Allowlist only — no arbitrary pass-through.
 */

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import {
  requireRequestPrincipal,
  isRequestPrincipalError,
  mapRequestPrincipalError,
} from "../request-principal.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HERMES_BODY_LIMIT = 64 * 1024; // 64 KiB

// Safe platform/channel id: lowercase-start slug, 1–63 chars.
// Mirrors the SAFE_SLUG from app-db-types.ts.
const SAFE_SLUG = /^[a-z][a-z0-9_-]{0,62}$/;

// PairingId: UUID v4 format or simple alphanumeric token up to 128 chars.
const PAIRING_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

// ---------------------------------------------------------------------------
// URL validation (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Validate that the given URL resolves to loopback (127.x, ::1, localhost).
 * Throws if the URL is non-loopback to prevent SSRF.
 */
export function validateHermesDashboardUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`HERMES_DASHBOARD_URL is not a valid URL: ${rawUrl}`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // IPv6 loopback
  if (hostname === "::1") return;

  // Hostname "localhost" acceptable (resolves to 127.x or ::1 on
  // well-configured hosts).  Residual DNS-rebinding risk documented in §4.
  if (hostname === "localhost") return;

  // IPv4: must start with 127.
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
    if (hostname.startsWith("127.")) return;
    throw new Error(
      `HERMES_DASHBOARD_URL must resolve to loopback; got ${hostname}`,
    );
  }

  throw new Error(
    `HERMES_DASHBOARD_URL must be a loopback address (127.x, ::1, localhost); got ${hostname}`,
  );
}

// ---------------------------------------------------------------------------
// Upstream fetch helper
// ---------------------------------------------------------------------------

const DEFAULT_HERMES_BASE_URL = "http://127.0.0.1:9119";

function getBaseUrl(): string {
  return process.env.HERMES_DASHBOARD_URL ?? DEFAULT_HERMES_BASE_URL;
}

class HermesUnavailableError extends Error {
  constructor(cause?: unknown) {
    super("Hermes upstream is unavailable");
    this.name = "HermesUnavailableError";
    if (cause !== undefined) this.cause = cause;
  }
}

type FetchInit = Omit<RequestInit, "signal" | "redirect">;

/**
 * Fetch from Hermes dashboard.
 * - Hard timeout of 10 s.
 * - redirect: "error" (no redirect following).
 * - Maps connection/abort errors → HermesUnavailableError.
 */
async function hermesFetch(path: string, init: FetchInit = {}): Promise<Response> {
  const url = `${getBaseUrl()}${path}`;
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch (err) {
    console.error(
      "[hermes-proxy] upstream fetch failed:",
      err instanceof Error ? err.message : String(err),
    );
    throw new HermesUnavailableError(err);
  }
}

// ---------------------------------------------------------------------------
// Response helpers (use `any` for c — consistent with canvas/routes.ts pattern)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unavailable(c: any) {
  return c.json({ error: "hermes_unavailable" }, 503) as Response;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function upstreamError(c: any, status: 502 | 503 = 502) {
  return c.json({ error: "upstream_error" }, status) as Response;
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function checkAuth(c: any): Response | null {
  try {
    requireRequestPrincipal(c);
    return null;
  } catch (err) {
    if (isRequestPrincipalError(err)) {
      const mapped = mapRequestPrincipalError(err);
      if (mapped.log) console.error("[hermes-proxy] auth error:", err);
      return c.json(mapped.body, mapped.status) as Response;
    }
    console.error("[hermes-proxy] unexpected auth error:", err);
    return c.json({ error: "Internal server error" }, 500) as Response;
  }
}

// ---------------------------------------------------------------------------
// Zod schemas (per-endpoint)
// ---------------------------------------------------------------------------

const ModelSetSchema = z.object({
  scope: z.enum(["main", "auxiliary"]),
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(256),
  task: z.string().max(128).optional(),
  base_url: z.string().url().optional(),
});

const EnvSetSchema = z.object({
  key: z.string().min(1).max(256),
  value: z.string().max(4096),
});

const PlatformUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  env: z.record(z.string(), z.string()).optional(),
  clear_env: z.array(z.string()).optional(),
});

const TelegramOnboardingStartSchema = z.object({
  bot_name: z.string().max(128).optional(),
});

const TelegramOnboardingApplySchema = z.object({
  allowed_user_ids: z.array(z.string().max(64)),
});

// ---------------------------------------------------------------------------
// Deps type (reserved for future injection)
// ---------------------------------------------------------------------------

export interface HermesRouteDeps {
  // Reserved — upstream base URL comes from process.env.HERMES_DASHBOARD_URL.
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export function createHermesRoutes(_deps: HermesRouteDeps = {}): Hono {
  const app = new Hono();

  // ------------------------------------------------------------------
  // GET /status  (aggregates /api/status + /api/model/info into coarse shape)
  // ------------------------------------------------------------------
  app.get("/status", async (c) => {
    const authErr = checkAuth(c);
    if (authErr) return authErr;

    try {
      const [statusRes, infoRes] = await Promise.all([
        hermesFetch("/api/status").catch(() => null),
        hermesFetch("/api/model/info").catch(() => null),
      ]);

      if (!statusRes || !statusRes.ok) {
        return c.json({ running: false, configured: false });
      }

      let statusData: Record<string, unknown> = {};
      try { statusData = await statusRes.json() as Record<string, unknown>; } catch { /* ignore */ }

      let infoData: Record<string, unknown> = {};
      if (infoRes && infoRes.ok) {
        try { infoData = await infoRes.json() as Record<string, unknown>; } catch { /* ignore */ }
      }

      const running = Boolean(statusData.gateway_running);
      const model = typeof infoData.model === "string" ? infoData.model : undefined;
      const provider = typeof infoData.provider === "string" ? infoData.provider : undefined;
      const configured = Boolean(model || provider);

      return c.json({
        running,
        configured,
        ...(model !== undefined ? { model } : {}),
        ...(provider !== undefined ? { provider } : {}),
      });
    } catch (err) {
      if (err instanceof HermesUnavailableError) {
        return c.json({ running: false, configured: false });
      }
      console.error("[hermes-proxy] /status unexpected error:", err);
      return c.json({ running: false, configured: false });
    }
  });

  // ------------------------------------------------------------------
  // GET /config
  // ------------------------------------------------------------------
  app.get("/config", async (c) => {
    const authErr = checkAuth(c);
    if (authErr) return authErr;

    try {
      const res = await hermesFetch("/api/config");
      if (!res.ok) return upstreamError(c);
      return c.json(await res.json());
    } catch (err) {
      if (err instanceof HermesUnavailableError) return unavailable(c);
      console.error("[hermes-proxy] /config error:", err);
      return upstreamError(c, 503);
    }
  });

  // ------------------------------------------------------------------
  // GET /model/options
  // ------------------------------------------------------------------
  app.get("/model/options", async (c) => {
    const authErr = checkAuth(c);
    if (authErr) return authErr;

    try {
      const res = await hermesFetch("/api/model/options");
      if (!res.ok) return upstreamError(c);
      return c.json(await res.json());
    } catch (err) {
      if (err instanceof HermesUnavailableError) return unavailable(c);
      console.error("[hermes-proxy] /model/options error:", err);
      return upstreamError(c, 503);
    }
  });

  // ------------------------------------------------------------------
  // GET /model/info
  // ------------------------------------------------------------------
  app.get("/model/info", async (c) => {
    const authErr = checkAuth(c);
    if (authErr) return authErr;

    try {
      const res = await hermesFetch("/api/model/info");
      if (!res.ok) return upstreamError(c);
      return c.json(await res.json());
    } catch (err) {
      if (err instanceof HermesUnavailableError) return unavailable(c);
      console.error("[hermes-proxy] /model/info error:", err);
      return upstreamError(c, 503);
    }
  });

  // ------------------------------------------------------------------
  // POST /model/set
  // ------------------------------------------------------------------
  app.post("/model/set", bodyLimit({ maxSize: HERMES_BODY_LIMIT }), async (c) => {
    const authErr = checkAuth(c);
    if (authErr) return authErr;

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const parsed = ModelSetSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    try {
      const res = await hermesFetch("/api/model/set", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (!res.ok) return upstreamError(c);
      return c.json(await res.json());
    } catch (err) {
      if (err instanceof HermesUnavailableError) return unavailable(c);
      console.error("[hermes-proxy] /model/set error:", err);
      return upstreamError(c, 503);
    }
  });

  // ------------------------------------------------------------------
  // GET /env  (redacted only — reveal is out of scope)
  // ------------------------------------------------------------------
  app.get("/env", async (c) => {
    const authErr = checkAuth(c);
    if (authErr) return authErr;

    try {
      const res = await hermesFetch("/api/env");
      if (!res.ok) return upstreamError(c);
      return c.json(await res.json());
    } catch (err) {
      if (err instanceof HermesUnavailableError) return unavailable(c);
      console.error("[hermes-proxy] GET /env error:", err);
      return upstreamError(c, 503);
    }
  });

  // ------------------------------------------------------------------
  // PUT /env  (write-only key/value)
  // ------------------------------------------------------------------
  app.put("/env", bodyLimit({ maxSize: HERMES_BODY_LIMIT }), async (c) => {
    const authErr = checkAuth(c);
    if (authErr) return authErr;

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const parsed = EnvSetSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    try {
      const res = await hermesFetch("/api/env", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (!res.ok) return upstreamError(c);
      return c.json(await res.json());
    } catch (err) {
      if (err instanceof HermesUnavailableError) return unavailable(c);
      console.error("[hermes-proxy] PUT /env error:", err);
      return upstreamError(c, 503);
    }
  });

  // ------------------------------------------------------------------
  // GET /messaging/platforms
  // ------------------------------------------------------------------
  app.get("/messaging/platforms", async (c) => {
    const authErr = checkAuth(c);
    if (authErr) return authErr;

    try {
      const res = await hermesFetch("/api/messaging/platforms");
      if (!res.ok) return upstreamError(c);
      return c.json(await res.json());
    } catch (err) {
      if (err instanceof HermesUnavailableError) return unavailable(c);
      console.error("[hermes-proxy] GET /messaging/platforms error:", err);
      return upstreamError(c, 503);
    }
  });

  // ------------------------------------------------------------------
  // PUT /messaging/platforms/:id
  // ------------------------------------------------------------------
  app.put("/messaging/platforms/:id", bodyLimit({ maxSize: HERMES_BODY_LIMIT }), async (c) => {
    const authErr = checkAuth(c);
    if (authErr) return authErr;

    const id = c.req.param("id");
    if (!SAFE_SLUG.test(id)) {
      return c.json({ error: "Invalid platform id" }, 400);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const parsed = PlatformUpdateSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    try {
      const res = await hermesFetch(`/api/messaging/platforms/${id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (!res.ok) return upstreamError(c);
      return c.json(await res.json());
    } catch (err) {
      if (err instanceof HermesUnavailableError) return unavailable(c);
      console.error("[hermes-proxy] PUT /messaging/platforms/:id error:", err);
      return upstreamError(c, 503);
    }
  });

  // ------------------------------------------------------------------
  // POST /messaging/platforms/:id/test  (coarse result only)
  // ------------------------------------------------------------------
  app.post(
    "/messaging/platforms/:id/test",
    bodyLimit({ maxSize: HERMES_BODY_LIMIT }),
    async (c) => {
      const authErr = checkAuth(c);
      if (authErr) return authErr;

      const id = c.req.param("id");
      if (!SAFE_SLUG.test(id)) {
        return c.json({ error: "Invalid platform id" }, 400);
      }

      try {
        const res = await hermesFetch(`/api/messaging/platforms/${id}/test`, {
          method: "POST",
        });
        if (!res.ok) {
          return c.json({ ok: false, state: "error", message: "Test failed" });
        }
        const data = await res.json() as Record<string, unknown>;
        // Return only coarse fields; never forward provider/path detail
        return c.json({
          ok: Boolean(data.ok),
          state: typeof data.state === "string" ? data.state : "unknown",
          message: data.ok ? "Connection successful" : "Test failed",
        });
      } catch (err) {
        if (err instanceof HermesUnavailableError) return unavailable(c);
        console.error("[hermes-proxy] POST /messaging/platforms/:id/test error:", err);
        return c.json({ ok: false, state: "error", message: "Test failed" });
      }
    },
  );

  // ------------------------------------------------------------------
  // POST /messaging/telegram/onboarding  (start QR flow)
  // ------------------------------------------------------------------
  app.post(
    "/messaging/telegram/onboarding",
    bodyLimit({ maxSize: HERMES_BODY_LIMIT }),
    async (c) => {
      const authErr = checkAuth(c);
      if (authErr) return authErr;

      let raw: unknown = {};
      try {
        const text = await c.req.text();
        if (text.trim()) raw = JSON.parse(text);
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }

      const parsed = TelegramOnboardingStartSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: "Invalid request body" }, 400);
      }

      try {
        const res = await hermesFetch("/api/messaging/telegram/onboarding/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(parsed.data),
        });
        if (!res.ok) return upstreamError(c);
        return c.json(await res.json());
      } catch (err) {
        if (err instanceof HermesUnavailableError) return unavailable(c);
        console.error("[hermes-proxy] POST /messaging/telegram/onboarding error:", err);
        return upstreamError(c, 503);
      }
    },
  );

  // ------------------------------------------------------------------
  // GET /messaging/telegram/onboarding/:pairingId  (poll)
  // ------------------------------------------------------------------
  app.get("/messaging/telegram/onboarding/:pairingId", async (c) => {
    const authErr = checkAuth(c);
    if (authErr) return authErr;

    const pairingId = c.req.param("pairingId");
    if (!PAIRING_ID_PATTERN.test(pairingId)) {
      return c.json({ error: "Invalid pairing id" }, 400);
    }

    try {
      const res = await hermesFetch(
        `/api/messaging/telegram/onboarding/${pairingId}`,
      );
      if (!res.ok) return upstreamError(c);
      const data = await res.json() as Record<string, unknown>;
      // Return coarse poll shape only
      return c.json({
        status: typeof data.status === "string" ? data.status : "waiting",
        ...(data.bot_username !== undefined ? { bot_username: data.bot_username } : {}),
        ...(data.owner_user_id !== undefined ? { owner_user_id: data.owner_user_id } : {}),
        ...(data.expires_at !== undefined ? { expires_at: data.expires_at } : {}),
      });
    } catch (err) {
      if (err instanceof HermesUnavailableError) return unavailable(c);
      console.error("[hermes-proxy] GET /messaging/telegram/onboarding/:pairingId error:", err);
      return upstreamError(c, 503);
    }
  });

  // ------------------------------------------------------------------
  // POST /messaging/telegram/onboarding/:pairingId/apply
  // ------------------------------------------------------------------
  app.post(
    "/messaging/telegram/onboarding/:pairingId/apply",
    bodyLimit({ maxSize: HERMES_BODY_LIMIT }),
    async (c) => {
      const authErr = checkAuth(c);
      if (authErr) return authErr;

      const pairingId = c.req.param("pairingId");
      if (!PAIRING_ID_PATTERN.test(pairingId)) {
        return c.json({ error: "Invalid pairing id" }, 400);
      }

      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }

      const parsed = TelegramOnboardingApplySchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ error: "Invalid request body" }, 400);
      }

      try {
        const res = await hermesFetch(
          `/api/messaging/telegram/onboarding/${pairingId}/apply`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(parsed.data),
          },
        );
        if (!res.ok) return upstreamError(c);
        return c.json(await res.json());
      } catch (err) {
        if (err instanceof HermesUnavailableError) return unavailable(c);
        console.error(
          "[hermes-proxy] POST /messaging/telegram/onboarding/:pairingId/apply error:",
          err,
        );
        return upstreamError(c, 503);
      }
    },
  );

  // ------------------------------------------------------------------
  // DELETE /messaging/telegram/onboarding/:pairingId  (cancel)
  // ------------------------------------------------------------------
  app.delete(
    "/messaging/telegram/onboarding/:pairingId",
    bodyLimit({ maxSize: HERMES_BODY_LIMIT }),
    async (c) => {
      const authErr = checkAuth(c);
      if (authErr) return authErr;

      const pairingId = c.req.param("pairingId");
      if (!PAIRING_ID_PATTERN.test(pairingId)) {
        return c.json({ error: "Invalid pairing id" }, 400);
      }

      try {
        const res = await hermesFetch(
          `/api/messaging/telegram/onboarding/${pairingId}`,
          { method: "DELETE" },
        );
        if (!res.ok) return upstreamError(c);
        return c.json(await res.json());
      } catch (err) {
        if (err instanceof HermesUnavailableError) return unavailable(c);
        console.error(
          "[hermes-proxy] DELETE /messaging/telegram/onboarding/:pairingId error:",
          err,
        );
        return upstreamError(c, 503);
      }
    },
  );

  return app;
}
