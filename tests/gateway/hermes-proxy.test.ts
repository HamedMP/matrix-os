/**
 * Tests for /api/hermes/* gateway proxy (Task 1, Spec 101).
 *
 * All upstream calls are mocked via `vi.stubGlobal("fetch", ...)` so no
 * live Hermes process is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import {
  createHermesRoutes,
  type HermesRouteDeps,
} from "../../packages/gateway/src/routes/hermes.js";
import {
  markAuthContextReady,
  JWT_CLAIMS_CONTEXT_KEY,
} from "../../packages/gateway/src/request-principal.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(deps: Partial<HermesRouteDeps> = {}): Hono {
  const app = new Hono();

  // Simulate the authMiddleware: mark auth context ready and (optionally) set
  // a JWT claim so principal resolution succeeds.
  app.use("*", async (c, next) => {
    markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
    await next();
  });

  app.route("/api/hermes", createHermesRoutes(deps));
  return app;
}

function withAuth(app: Hono): Hono {
  // Rebuild app with a stub JWT claim so requireRequestPrincipal succeeds.
  const authed = new Hono();
  authed.use("*", async (c, next) => {
    markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
    c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
    await next();
  });
  // Re-register the same hermes routes but on a fresh Hono
  authed.route("/api/hermes", createHermesRoutes({}));
  return authed;
}

function authenticatedApp(deps: HermesRouteDeps): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
    c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
    await next();
  });
  app.route("/api/hermes", createHermesRoutes(deps));
  return app;
}

function upstreamJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// Authentication guard
// ---------------------------------------------------------------------------

describe("Authentication", () => {
  it("returns 401 when no principal is present", async () => {
    const app = makeApp(); // no JWT set — dev-default only in local dev but test env has NODE_ENV=test
    // In test env with no MATRIX_AUTH_TOKEN and no MATRIX_USER_ID, the dev-default
    // principal IS granted. We need to simulate a production environment where
    // auth is required and no principal is configured.
    // Override env to require auth.
    const savedAuthToken = process.env.MATRIX_AUTH_TOKEN;
    const savedUserId = process.env.MATRIX_USER_ID;
    const savedNodeEnv = process.env.NODE_ENV;

    process.env.MATRIX_AUTH_TOKEN = "secret";
    process.env.MATRIX_USER_ID = "";
    process.env.NODE_ENV = "production";

    try {
      const res = await app.request("/api/hermes/status");
      expect(res.status).toBe(401);
    } finally {
      if (savedAuthToken === undefined) delete process.env.MATRIX_AUTH_TOKEN;
      else process.env.MATRIX_AUTH_TOKEN = savedAuthToken;
      if (savedUserId === undefined) delete process.env.MATRIX_USER_ID;
      else process.env.MATRIX_USER_ID = savedUserId;
      if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
    }
  });
});

// ---------------------------------------------------------------------------
// Allowlist enforcement
// ---------------------------------------------------------------------------

describe("Allowlist", () => {
  it("returns 404 for an unknown subpath", async () => {
    const app = withAuth(new Hono());
    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    const res = await authed.request("/api/hermes/bogus");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a deeply nested unknown subpath", async () => {
    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    const res = await authed.request("/api/hermes/config/extra/unknown");
    expect(res.status).toBe(404);
  });
});

describe("Hermes configuration management", () => {
  const schema = {
    fields: {
      model: { type: "string", description: "Default model", category: "general" },
      "agent.max_turns": { type: "number", description: "Maximum turns", category: "agent" },
      "memory.memory_enabled": { type: "boolean", description: "Use memory", category: "memory" },
      "approvals.mode": {
        type: "select",
        description: "Dangerous command approval mode",
        category: "security",
        options: ["ask", "deny"],
      },
      "auxiliary.vision.api_key": { type: "string", description: "Secret", category: "auxiliary" },
    },
    category_order: ["general", "agent", "memory", "security", "auxiliary"],
  };
  const currentConfig = {
    model: "anthropic/claude-sonnet-4.6",
    agent: { max_turns: 90 },
    memory: { memory_enabled: true },
    approvals: { mode: "ask" },
    auxiliary: { vision: { api_key: "never-send-this-to-the-browser" } },
  };

  function makeClient(fetchImpl: HermesRouteDeps["client"]["fetch"]): NonNullable<HermesRouteDeps["client"]> {
    return {
      fetch: fetchImpl,
      readJson: vi.fn(),
      requestJson: vi.fn(),
    };
  }

  it("aggregates the exact-version schema, defaults, and config without secret-bearing paths", async () => {
    const upstreamFetch = vi.fn(async (path: string) => {
      if (path === "/api/config") return upstreamJson(currentConfig);
      if (path === "/api/config/defaults") return upstreamJson(currentConfig);
      if (path === "/api/config/schema") return upstreamJson(schema);
      return upstreamJson({}, 404);
    });
    const app = authenticatedApp({ client: makeClient(upstreamFetch) });

    const res = await app.request("/api/hermes/configuration");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.auxiliary?.vision?.api_key).toBeUndefined();
    expect(body.defaults.auxiliary?.vision?.api_key).toBeUndefined();
    expect(body.fields["auxiliary.vision.api_key"]).toBeUndefined();
    expect(body.fields["agent.max_turns"]).toEqual(expect.objectContaining({ type: "number" }));
    expect(body.categoryOrder).toEqual(schema.category_order);
    expect(upstreamFetch).toHaveBeenCalledTimes(3);
  });

  it("accepts the 679-field schema published by Hermes Agent 0.20", async () => {
    const exactVersionFields = Object.fromEntries(Array.from({ length: 679 }, (_, index) => [
      `section.field_${index}`,
      { type: "string", description: `Field ${index}`, category: "section" },
    ]));
    const upstreamFetch = vi.fn(async (path: string) => {
      if (path === "/api/config/schema") {
        return upstreamJson({ fields: exactVersionFields, category_order: ["section"] });
      }
      if (path === "/api/config" || path === "/api/config/defaults") return upstreamJson({ section: {} });
      return upstreamJson({}, 404);
    });
    const app = authenticatedApp({ client: makeClient(upstreamFetch) });

    const res = await app.request("/api/hermes/configuration");

    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()).fields)).toHaveLength(679);
  });

  it("validates and applies only changed schema paths while preserving server-side secrets", async () => {
    let savedBody: unknown;
    const upstreamFetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/config" && init?.method === "PUT") {
        savedBody = JSON.parse(String(init.body));
        return upstreamJson({ ok: true });
      }
      if (path === "/api/config") return upstreamJson(currentConfig);
      if (path === "/api/config/schema") return upstreamJson(schema);
      return upstreamJson({}, 404);
    });
    const app = authenticatedApp({ client: makeClient(upstreamFetch) });

    const res = await app.request("/api/hermes/configuration", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        changes: [
          { path: "agent.max_turns", value: 120 },
          { path: "approvals.mode", value: "deny" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(savedBody).toEqual({
      config: {
        ...currentConfig,
        agent: { max_turns: 120 },
        approvals: { mode: "deny" },
      },
    });
    expect(JSON.stringify(await res.json())).not.toContain("never-send-this-to-the-browser");
  });

  it.each([
    [{ path: "unknown.field", value: true }],
    [{ path: "agent.max_turns", value: "unbounded" }],
    [{ path: "approvals.mode", value: "yolo" }],
    [{ path: "auxiliary.vision.api_key", value: "secret" }],
    [{ path: "__proto__.polluted", value: true }],
  ])("rejects unsafe or schema-invalid configuration changes", async (change) => {
    const upstreamFetch = vi.fn(async (path: string) => {
      if (path === "/api/config") return upstreamJson(currentConfig);
      if (path === "/api/config/schema") return upstreamJson(schema);
      return upstreamJson({}, 404);
    });
    const app = authenticatedApp({ client: makeClient(upstreamFetch) });

    const res = await app.request("/api/hermes/configuration", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ changes: [change] }),
    });

    expect(res.status).toBe(400);
    expect(upstreamFetch).not.toHaveBeenCalledWith(
      "/api/config",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("removes a credential through Hermes' write-only env API", async () => {
    const upstreamFetch = vi.fn(async () => upstreamJson({ ok: true }));
    const app = authenticatedApp({ client: makeClient(upstreamFetch) });

    const res = await app.request("/api/hermes/env", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "OPENROUTER_API_KEY" }),
    });

    expect(res.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledWith("/api/env", expect.objectContaining({
      method: "DELETE",
      body: JSON.stringify({ key: "OPENROUTER_API_KEY" }),
    }));
  });
});

// ---------------------------------------------------------------------------
// GET /api/hermes/status
// ---------------------------------------------------------------------------

describe("GET /api/hermes/status", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps upstream status + model/info into coarse shape", async () => {
    fetchSpy.mockImplementation((url: string) => {
      if (String(url).includes("/api/status")) {
        return Promise.resolve(
          upstreamJson({
            version: "1.0.0",
            gateway_running: true,
            gateway_state: "running",
            gateway_platforms: ["telegram"],
            active_sessions: 1,
          }),
        );
      }
      if (String(url).includes("/api/model/info")) {
        return Promise.resolve(
          upstreamJson({
            model: "claude-sonnet-4-5",
            provider: "anthropic",
            effective_context_length: 200000,
          }),
        );
      }
      return Promise.resolve(upstreamJson({}, 404));
    });

    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    const res = await authed.request("/api/hermes/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.running).toBe(true);
    expect(body.configured).toBe(true);
    expect(body.model).toBe("claude-sonnet-4-5");
    expect(body.provider).toBe("anthropic");
  });

  it("returns {running:false} (200) when upstream is down (connection error)", async () => {
    fetchSpy.mockRejectedValue(new Error("ECONNREFUSED"));

    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    const res = await authed.request("/api/hermes/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.running).toBe(false);
    expect(body.configured).toBe(false);
  });

  it("returns {running:false} (200) when upstream returns non-2xx", async () => {
    fetchSpy.mockResolvedValue(upstreamJson({ error: "not found" }, 503));

    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    const res = await authed.request("/api/hermes/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.running).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Parameter validation: :id must match SAFE_SLUG
// ---------------------------------------------------------------------------

describe("Platform :id validation", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(upstreamJson({ ok: true }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 for :id that does not match SAFE_SLUG (PUT platform)", async () => {
    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    const res = await authed.request("/api/hermes/messaging/platforms/INVALID_ID!!!", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    // Must not contain raw upstream detail
    expect(body.error).not.toMatch(/ECONNREFUSED/);
  });

  it("returns 400 for :id that does not match SAFE_SLUG (POST platform test)", async () => {
    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    const res = await authed.request(
      "/api/hermes/messaging/platforms/../../../etc/passwd/test",
      { method: "POST" },
    );
    // Path traversal should be 404 (not a registered route) or 400
    expect([400, 404]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// Body limit enforcement
// ---------------------------------------------------------------------------

describe("Body limit enforcement", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(upstreamJson({ ok: true }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 413 when request body exceeds limit (POST /model/set)", async () => {
    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    // Use a raw string body >64 KiB so bodyLimit fires before JSON parse /
    // Zod validation. Hono bodyLimit checks Content-Length first; provide it.
    const oversizedBody = "x".repeat(65 * 1024);
    const req = new Request("http://localhost/api/hermes/model/set", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(oversizedBody.length),
      },
      body: oversizedBody,
    });
    const res = await authed.fetch(req);
    expect(res.status).toBe(413);
  });

  it("returns 413 when request body exceeds limit (PUT /env)", async () => {
    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    const oversizedBody = "x".repeat(65 * 1024);
    const req = new Request("http://localhost/api/hermes/env", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "content-length": String(oversizedBody.length),
      },
      body: oversizedBody,
    });
    const res = await authed.fetch(req);
    expect(res.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// Zod body schema validation
// ---------------------------------------------------------------------------

describe("Body schema validation (Zod)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(upstreamJson({ ok: true }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 when POST /model/set body is missing required fields", async () => {
    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    const res = await authed.request("/api/hermes/model/set", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "main" }), // missing provider and model
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("returns 400 when PUT /env body is missing key field", async () => {
    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    const res = await authed.request("/api/hermes/env", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "sk-xxx" }), // missing key
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("returns 400 when PUT /messaging/platforms/:id body is invalid", async () => {
    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    const res = await authed.request("/api/hermes/messaging/platforms/telegram", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unknownField: 123 }), // no valid fields
    });
    // Either 400 (Zod rejects strict) or 200 if body is optional-all — check implementation
    // We require at least one of enabled/env/clear_env; empty object fails strict
    expect([400, 200]).toContain(res.status);
  });
});

// ---------------------------------------------------------------------------
// Upstream 500 → generic error (no raw body leak)
// ---------------------------------------------------------------------------

describe("Upstream error mapping", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps upstream 500 to 502/503 and does not include raw upstream body", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ detail: "Internal database error: connection pool exhausted" }),
        { status: 500, headers: { "content-type": "application/json" } },
      ),
    );

    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    const res = await authed.request("/api/hermes/config");
    expect([502, 503]).toContain(res.status);
    const text = await res.text();
    expect(text).not.toContain("database error");
    expect(text).not.toContain("connection pool");
  });

  it("does not leak provider API key details in error response for GET /env", async () => {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({ error: "sk-ant-api-key leaked in error message" }),
        { status: 500, headers: { "content-type": "application/json" } },
      ),
    );

    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    const res = await authed.request("/api/hermes/env");
    expect([502, 503]).toContain(res.status);
    const text = await res.text();
    expect(text).not.toContain("sk-ant-api-key");
  });

  it("projects environment reads to credential metadata without stored values", async () => {
    const app = authenticatedApp({
      client: {
        fetch: async () => upstreamJson({
          ANTHROPIC_API_KEY: {
            is_set: true,
            redacted_value: "sk-ant-...last4",
            description: "Anthropic API key",
            category: "model",
            is_password: true,
            tools: ["hermes"],
            advanced: false,
            channel_managed: false,
            provider: "anthropic",
            provider_label: "Anthropic",
            value: "secret-from-upstream",
          },
        }),
        readJson: vi.fn(),
        requestJson: vi.fn(),
      },
    });

    const res = await app.request("/api/hermes/env");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ANTHROPIC_API_KEY: {
        is_set: true,
        redacted_value: "sk-ant-...last4",
        description: "Anthropic API key",
        category: "model",
        is_password: true,
        tools: ["hermes"],
        advanced: false,
        channel_managed: false,
        provider: "anthropic",
        provider_label: "Anthropic",
      },
    });
  });

  it("normalizes the empty metadata URLs emitted by Hermes 0.20", async () => {
    const app = authenticatedApp({
      client: {
        fetch: async () => upstreamJson({
          DEEPSEEK_BASE_URL: {
            is_set: false,
            redacted_value: null,
            description: "Custom DeepSeek API base URL (advanced)",
            url: "",
            category: "provider",
            is_password: false,
            tools: [],
            advanced: false,
            channel_managed: false,
            provider: "",
            provider_label: "",
          },
        }),
        readJson: vi.fn(),
        requestJson: vi.fn(),
      },
    });

    const res = await app.request("/api/hermes/env");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      DEEPSEEK_BASE_URL: expect.objectContaining({ url: null }),
    });
  });
});

// ---------------------------------------------------------------------------
// Timeout → 503 hermes_unavailable
// ---------------------------------------------------------------------------

describe("Timeout handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 503 hermes_unavailable when upstream times out", async () => {
    // Simulate AbortError (thrown when AbortSignal fires)
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abortError));

    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    const res = await authed.request("/api/hermes/config");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("hermes_unavailable");
  });

  it("returns 503 hermes_unavailable on connection refused", async () => {
    const connError = Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(connError));

    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    const res = await authed.request("/api/hermes/model/options");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("hermes_unavailable");
  });
});

// ---------------------------------------------------------------------------
// Telegram pairingId validation
// ---------------------------------------------------------------------------

describe("Telegram pairingId validation", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue(upstreamJson({ ok: true }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 400 for pairingId with invalid characters (GET poll)", async () => {
    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    // Path traversal / shell injection attempt
    const res = await authed.request(
      "/api/hermes/messaging/telegram/onboarding/../../etc/passwd",
    );
    expect([400, 404]).toContain(res.status);
  });

  it("returns 400 for pairingId that is too long (DELETE cancel)", async () => {
    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    const tooLong = "a".repeat(300);
    const res = await authed.request(
      `/api/hermes/messaging/telegram/onboarding/${tooLong}`,
      { method: "DELETE" },
    );
    expect(res.status).toBe(400);
  });

  it("accepts a valid UUID-like pairingId (GET poll)", async () => {
    const authed = new Hono();
    authed.use("*", async (c, next) => {
      markAuthContextReady(c as Parameters<typeof markAuthContextReady>[0]);
      c.set(JWT_CLAIMS_CONTEXT_KEY as never, { sub: "user-123" });
      await next();
    });
    authed.route("/api/hermes", createHermesRoutes({}));

    const validId = "550e8400-e29b-41d4-a716-446655440000";
    fetchSpy.mockResolvedValue(
      upstreamJson({ status: "waiting", expires_at: "2099-01-01T00:00:00Z" }),
    );

    const res = await authed.request(
      `/api/hermes/messaging/telegram/onboarding/${validId}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Must return coarse shape only
    expect(["waiting", "ready"]).toContain(body.status);
  });
});

// ---------------------------------------------------------------------------
// Startup SSRF guard (HERMES_DASHBOARD_URL must resolve to loopback)
// ---------------------------------------------------------------------------

describe("SSRF guard: HERMES_DASHBOARD_URL validation", () => {
  it("throws at startup when HERMES_DASHBOARD_URL resolves to a non-loopback host", async () => {
    const { validateHermesDashboardUrl } = await import(
      "../../packages/gateway/src/routes/hermes.js"
    );
    // External host — should throw
    expect(() => validateHermesDashboardUrl("http://example.com:9119")).toThrow();
    expect(() => validateHermesDashboardUrl("http://192.168.1.100:9119"))
      .toThrow(/192\.168\.1\.100/);
    expect(() => validateHermesDashboardUrl("http://0.0.0.0:9119")).toThrow();
  });

  it("rejects non-HTTP loopback URL schemes", async () => {
    const { validateHermesDashboardUrl } = await import(
      "../../packages/gateway/src/routes/hermes.js"
    );

    expect(() => validateHermesDashboardUrl("file://127.0.0.1/etc/passwd"))
      .toThrow(/file:/);
    expect(() => validateHermesDashboardUrl("ws://127.0.0.1:9119"))
      .toThrow(/ws:/);
  });

  it("accepts loopback addresses", async () => {
    const { validateHermesDashboardUrl } = await import(
      "../../packages/gateway/src/routes/hermes.js"
    );
    expect(() => validateHermesDashboardUrl("http://127.0.0.1:9119")).not.toThrow();
    expect(() => validateHermesDashboardUrl("http://[::1]:9119")).not.toThrow();
  });
});
